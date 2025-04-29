// server.js
const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const { Deepgram } = require('@deepgram/sdk');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');

// Environment variables
const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

const app = express();

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Route for TwiML ---
app.all('/twiml', (req, res) => {
  console.log('✅ [TwiML] /twiml hit');

  const params = req.query;

  const agentId = params.agent_id;
  const voiceId = params.voice_id;
  const contactName = params.contact_name;
  const address = params.address;

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [TwiML] Missing required fields', { agentId, voiceId, contactName, address });
    return res.status(400).send('Missing required fields');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agentId}&voice_id=${voiceId}&contact_name=${encodeURIComponent(contactName)}&address=${encodeURIComponent(address)}`
  });

  res.type('text/xml');
  res.send(response.toString());
});

// --- Create Server and WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// --- Handle WebSocket Upgrade ---
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;
  
  if (pathname === '/media') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- WebSocket Connection ---
wss.on('connection', (ws, request) => {
  console.log('📞 [WebSocket] New connection established');

  const params = new URLSearchParams(request.url.split('?')[1]);
  const agentId = params.get('agent_id');
  const voiceId = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address = params.get('address');

  console.log('🎯 [WebSocket Params]', { agentId, voiceId, contactName, address });

  const deepgram = new Deepgram(DEEPGRAM_API_KEY);
  const deepgramSocket = deepgram.transcription.live({
    language: 'en-AU',
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',
    sample_rate: 8000,
  });

  // --- WebSocket events ---
  ws.on('error', (error) => console.error('❌ [WebSocket Error]', error));
  ws.on('close', () => console.log('🔒 [WebSocket] Connection closed'));

  // --- Deepgram events ---
  deepgramSocket.on('open', () => console.log('🔗 [Deepgram] Connected'));
  deepgramSocket.on('error', (error) => console.error('❌ [Deepgram Error]', error));
  deepgramSocket.on('close', () => console.log('🔒 [Deepgram] Deepgram connection closed'));

  // --- Incoming WebSocket messages from Twilio ---
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        console.log('✅ [Twilio] Call started - StreamSid:', msg.streamSid);
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
        deepgramSocket.finish();
      }
    } catch (err) {
      console.error('❌ [Message Handling Error]', err);
    }
  });

  // --- Deepgram transcript received ---
  deepgramSocket.on('transcriptReceived', async (data) => {
    try {
      const transcript = data.channel.alternatives[0]?.transcript;
      if (transcript && transcript.length > 0) {
        console.log('📝 [Transcript]', transcript);

        const gptReply = await generateGPTReply(transcript, contactName, address);
        const audioStream = await streamVoiceFromElevenLabs(gptReply, voiceId);

        audioStream.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            const payload = Buffer.from(chunk).toString('base64');
            ws.send(JSON.stringify({ event: 'media', media: { payload } }));
          }
        });

        audioStream.on('end', () => {
          console.log('✅ [ElevenLabs] Voice streaming complete');
        });
      }
    } catch (err) {
      console.error('❌ [Transcript Handling Error]', err);
    }
  });
});

// --- Generate GPT-4 Reply ---
async function generateGPTReply(userText, contactName, address) {
  const systemPrompt = `You are an AI real estate assistant. You're calling ${contactName} about their property at ${address}. Offer a free property valuation and ask politely if they want an update on recent sales. Keep it conversational and natural.`;

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
  console.log('🤖 [GPT-4 Reply]', reply);
  return reply;
}

// --- ElevenLabs Stream ---
async function streamVoiceFromElevenLabs(text, voiceId) {
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
        similarity_boost: 0.8,
      }
    },
    responseType: 'stream'
  });

  return response.data;
}

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
