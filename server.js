// server.js
const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const { Deepgram } = require('@deepgram/sdk');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');

// Environment Variables
const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

// Create Express App
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- TwiML Route ---
app.all('/twiml', (req, res) => {
  console.log('✅ [HTTP] /twiml HIT');

  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] Missing required fields', { agent_id, voice_id, contact_name, address });
    return res.status(400).send('Missing required fields (agent_id, voice_id, contact_name, address)');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${encodeURIComponent(contact_name)}&address=${encodeURIComponent(address)}`
  });

  res.type('text/xml');
  res.send(response.toString());
});

// --- Create HTTP server ---
const server = http.createServer(app);

// --- WebSocket Server ---
const wss = new WebSocket.Server({ noServer: true });

// --- WebSocket Upgrade Handling ---
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  console.log('📡 [Upgrade Request]', pathname);

  if (pathname === '/media') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    console.warn('❌ [Upgrade] Unknown path, destroying socket:', pathname);
    socket.destroy();
  }
});

// --- WebSocket Connection Handling ---
wss.on('connection', (ws, request) => {
  console.log('🔗 [WebSocket] Connection established ✅');

  const params = new URLSearchParams(request.url.split('?')[1]);
  const agentId = params.get('agent_id');
  const voiceId = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address = params.get('address');

  console.log('🎯 [Session Details]', { agentId, voiceId, contactName, address });

  const deepgram = new Deepgram(DEEPGRAM_API_KEY);
  const deepgramSocket = deepgram.transcription.live({
    language: 'en-AU',
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',
    sample_rate: 8000,
  });

  // Deepgram event listeners
  deepgramSocket.on('open', () => console.log('🛰️ [Deepgram] Connected'));
  deepgramSocket.on('error', (err) => console.error('❌ [Deepgram Error]', err));
  deepgramSocket.on('close', () => console.log('🔒 [Deepgram] Connection closed'));

  ws.on('error', (error) => console.error('❌ [WebSocket Error]', error));
  ws.on('close', () => {
    console.log('🔒 [WebSocket] Connection closed');
    deepgramSocket.finish();
  });

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        console.log('▶️ [Twilio] Call started - StreamSid:', msg.streamSid);
      }

      if (msg.event === 'media') {
        const audio = Buffer.from(msg.media.payload, 'base64');
        if (deepgramSocket.readyState === 1) {
          deepgramSocket.send(audio);
        }
      }

      if (msg.event === 'stop') {
        console.log('🛑 [Twilio] Call stopped - StreamSid:', msg.streamSid);
        ws.close();
      }
    } catch (err) {
      console.error('❌ [WebSocket Message Handling Error]', err);
    }
  });

  // Deepgram Transcript received
  deepgramSocket.on('transcriptReceived', async (data) => {
    try {
      const transcript = data.channel.alternatives[0]?.transcript;
      if (transcript && transcript.length > 0) {
        console.log('📝 [Transcript]', transcript);

        const gptReply = await generateReply(transcript, contactName, address);
        const audioStream = await streamFromElevenLabs(gptReply, voiceId);

        audioStream.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            const payload = Buffer.from(chunk).toString('base64');
            ws.send(JSON.stringify({ event: 'media', media: { payload } }));
          }
        });

        audioStream.on('end', () => {
          console.log('✅ [ElevenLabs] Voice streaming completed');
        });
      }
    } catch (err) {
      console.error('❌ [Transcript Handling Error]', err);
    }
  });
});

// --- GPT-4 Reply Generation ---
async function generateReply(userText, contactName, address) {
  const systemPrompt = `You are a friendly real estate agent assistant. You are calling ${contactName} about their property at ${address}. Offer a free valuation and politely ask if they are considering selling.`;
  
  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const reply = response.data.choices[0].message.content;
  console.log('🤖 [GPT-4o Reply]', reply);
  return reply;
}

// --- ElevenLabs Stream Voice ---
async function streamFromElevenLabs(text, voiceId) {
  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    },
    data: {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      }
    },
    responseType: 'stream'
  });

  return response.data;
}

// --- Start the server ---
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
