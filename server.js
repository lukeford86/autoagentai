const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Serve dynamic TwiML ---
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

  // NO intro message — we stay silent until the person speaks
  res.type('text/xml');
  res.send(response.toString());
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
const http = require('http');
const WebSocket = require('ws');

// Create a raw HTTP server
const server = http.createServer(app);

// Attach WebSocket server to it
const wss = new WebSocket.Server({ server, path: '/media' });

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('📞 Twilio Media Stream connected');

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.event === 'start') {
      console.log(`✅ Call started with stream SID: ${message.streamSid}`);
    }

    if (message.event === 'media') {
      // Incoming audio chunks
      const audioData = message.media.payload; // base64 audio

      // For now: just log we are receiving audio
      console.log(`🎙️ Receiving audio data...`);
      // Later: pipe this audio to Deepgram
    }

    if (message.event === 'stop') {
      console.log(`🛑 Call ended for stream SID: ${message.streamSid}`);
      ws.close();
    }
  });

  ws.on('close', () => {
    console.log('🔒 WebSocket connection closed');
  });
});

// Change only the *listening* line at the bottom:
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
