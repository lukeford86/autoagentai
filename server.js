// Basic Express + Twilio + WebSocket server setup

const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const { Deepgram } = require('@deepgram/sdk');
const http = require('http');
const WebSocket = require('ws');

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Load Deepgram API key
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const deepgram = new Deepgram(deepgramApiKey);

// --- Serve dynamic TwiML for Twilio outbound call ---
app.get('/twiml', (req, res) => {
  const agentId = req.query.agent_id;
  const voiceId = req.query.voice_id;

  if (!agentId || !voiceId) {
    return res.status(400).send('Missing agent_id or voice_id');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agentId}&voice_id=${voiceId}`,
  });

  // No welcome message — stay silent until user speaks
  res.type('text/xml');
  res.send(response.toString());
});

// --- Create HTTP server and attach WebSocket ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

// --- Handle WebSocket connections from Twilio ---
wss.on('connection', (ws, req) => {
  console.log('📞 Twilio Media Stream connected');

  // Pull agent_id and voice_id from the connection URL
  const params = new URLSearchParams(req.url.split('?')[1]);
  const agentId = params.get('agent_id');
  const voiceId = params.get('voice_id');

  console.log(`🎯 Agent ID: ${agentId}, Voice ID: ${voiceId}`);

  // --- Connect to Deepgram for live transcription ---
  const deepgramSocket = deepgram.transcription.live({
    language: 'en-AU', // or en-US
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',    // because Twilio streams mulaw 8000Hz
    sample_rate: 8000
  });

  deepgramSocket.on('open', () => {
    console.log('🔗 Connected to Deepgram Streaming');
  });

  deepgramSocket.on('transcriptReceived', (data) => {
    const transcript = data.channel.alternatives[0].transcript;
    if (transcript && transcript.length > 0) {
      console.log(`📝 Deepgram transcript: ${transcript}`);
      // ✅ TODO: Pass to GPT here to generate a reply
    }
  });

  deepgramSocket.on('error', (error) => {
    console.error('Deepgram Error:', error);
  });

  deepgramSocket.on('close', () => {
    console.log('🔒 Deepgram WebSocket closed');
  });

  // --- Handle incoming messages from Twilio WebSocket ---
  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.event === 'start') {
      console.log(`✅ Call started with stream SID: ${message.streamSid}`);
    }

    if (message.event === 'media') {
      const audioData = message.media.payload; // base64 encoded audio
      const buffer = Buffer.from(audioData, 'base64');

      // Forward raw audio to Deepgram for transcription
      if (deepgramSocket.readyState === 1) {
        deepgramSocket.send(buffer);
      }
    }

    if (message.event === 'stop') {
      console.log(`🛑 Call ended for stream SID: ${message.streamSid}`);
      ws.close();
      deepgramSocket.finish(); // Tell Deepgram the stream is complete
    }
  });

  ws.on('close', () => {
    console.log('🔒 Twilio WebSocket connection closed');
    if (deepgramSocket.readyState === 1) {
      deepgramSocket.finish();
    }
  });
});

// --- Start the combined server ---
server.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
