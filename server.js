// server.js
const express = require('express');
const http = require('http');
const { Server: WebSocketServer } = require('ws');
const { twiml: { VoiceResponse } } = require('twilio');
const url = require('url');
const { Deepgram } = require('@deepgram/sdk');
const axios = require('axios');

// Environment Variables
const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Initialize
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Webhook Route for TwiML
app.all('/twiml', (req, res) => {
  console.log('✅ [HTTP] /twiml HIT');

  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] Missing required fields');
    return res.status(400).send('Missing required fields (agent_id, voice_id, contact_name, address)');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${encodeURIComponent(contact_name)}&address=${encodeURIComponent(address)}`
  });

  res.type('text/xml');
  res.send(response.toString());
});

// --- Handle WebSocket Upgrades
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/media') {
    console.log('🔗 [UPGRADE] WebSocket Upgrade Request received');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    console.warn('❌ [UPGRADE] Unknown path, destroying socket');
    socket.destroy();
  }
});

// --- WebSocket Connection Handling
wss.on('connection', (ws, request) => {
  console.log('🛰️ [WebSocket] Connection established ✅');

  const params = new URLSearchParams(request.url.split('?')[1]);
  const agentId = params.get('agent_id');
  const voiceId = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address = params.get('address');

  console.log('🎯 [Session]', { agentId, voiceId, contactName, address });

  const deepgram = new Deepgram(DEEPGRAM_API_KEY);
  const dgSocket = deepgram.transcription.live({
    language: 'en-AU',
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',
    sample_rate: 8000,
  });

  let fullTranscript = '';

  dgSocket.on('open', () => console.log('🔊 [Deepgram] Connected'));
  dgSocket.on('error', (err) => console.error('❌ [Deepgram Error]', err));
  dgSocket.on('close', () => console.log('🔒 [Deepgram] Closed'));

  ws.on('close', () => {
    console.log('🔒 [WebSocket] Closed by client');
    dgSocket.finish();
  });

  ws.on('error', (err) => {
    console.error('❌ [WebSocket Error]', err);
    dgSocket.finish();
  });

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        console.log('▶️ [Twilio] Call started');
      }

      if (msg.event === 'media') {
        const audio = Buffer.from(msg.media.payload, 'base64');
        if (dgSocket.readyState === 1) {
          dgSocket.send(audio);
        }
      }

      if (msg.event === 'stop') {
        console.log('🛑 [Twilio] Call stopped');
        ws.close();
      }
    } catch (error) {
      console.error('❌ [Message Handling Error]', error);
    }
  });

  // Handle Deepgram transcripts
  dgSocket.on('transcriptReceived', async (data) => {
    try {
      const transcript = data.channel.alternatives[0]?.transcript;
      if (transcript && transcript.length > 0) {
        console.log('📝 [Transcript]', transcript);
        fullTranscript += transcript + ' ';

        const gptReply = await generateReply(transcript, contactName, address);
        const audioStream = await streamFromElevenLabs(gptReply, voiceId);

        audioStream.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            const payload = Buffer.from(chunk).toString('base64');
            ws.send(JSON.stringify({ event: 'media', media: { payload } }));
          }
        });

        audioStream.on('end', () => {
          console.log('✅ [ElevenLabs] Finished sending audio');
        });
      }
    } catch (error) {
      console.error('❌ [Transcript Handling Error]', error);
    }
  });
});

// --- Generate AI Reply using OpenRouter (GPT-4o)
async function generateReply(userText, contactName, address) {
  const systemPrompt = `You are a friendly real estate agent calling ${contactName} about their property at ${address}. Politely ask if they are considering selling.`;

  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ]
  }, {
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const reply = response.data.choices[0].message.content;
  console.log('🤖 [GPT-4o Reply]', reply);
  return reply;
}

// --- Stream AI Voice back via ElevenLabs
async function streamFromElevenLabs(text, voiceId) {
  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    data: {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      }
    },
    responseType: 'stream',
  });

  return response.data;
}

// --- Start server
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
