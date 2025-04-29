const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 10000;

// --- TwiML Endpoint ---
app.post('/twiml', express.urlencoded({ extended: true }), (req, res) => {
  console.log('✅ [HTTP] /twiml HIT');

  const agentId = req.query.agent_id;
  const voiceId = req.query.voice_id;
  const contactName = req.query.contact_name;
  const address = req.query.address;

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ Missing parameters');
    return res.status(400).send('Missing parameters');
  }

  const response = new VoiceResponse();
  
  // Build the safe URL
  const streamUrl = `wss://${req.headers.host}/media?agent_id=${encodeURIComponent(agentId)}&voice_id=${encodeURIComponent(voiceId)}&contact_name=${encodeURIComponent(contactName)}&address=${encodeURIComponent(address)}`;

  const start = response.start();
  start.stream({ url: streamUrl });

  res.type('text/xml');
  res.send(response.toString());
});

// --- WebSocket Server ---
const server = app.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
  console.log('==> 🎉 Your service is live');
});

// Attach WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('✅ [WS] WebSocket connection established');

  ws.on('message', (message) => {
    console.log('🎙️ [WS] Received message');
    // Later, handle audio/media packets here
  });

  ws.on('close', () => {
    console.log('❌ [WS] WebSocket closed');
  });

  ws.on('error', (error) => {
    console.error('❌ [WS] WebSocket error:', error);
  });
});
