const express = require('express');
const { VoiceResponse } = require('twilio').twiml;
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

// === TwiML to initiate streaming ===
app.get('/twiml', (req, res) => {
  console.log('✅ [HTTP] /twiml HIT');
  
  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    return res.status(400).send('Missing required fields: agent_id, voice_id, contact_name, address');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${contact_name}&address=${address}`
  });

  res.type('text/xml');
  res.send(response.toString());
});

// === Handle incoming WebSocket connection ===
wss.on('connection', (ws, req) => {
  console.log('✅ [WebSocket] Media stream connected');

  ws.on('message', (message) => {
    console.log('📥 [WebSocket] Received media packet:', message.length, 'bytes');
    // Here later you can handle live audio bytes if needed
  });

  ws.on('close', () => {
    console.log('❌ [WebSocket] Media stream closed');
  });

  ws.on('error', (err) => {
    console.error('⚠️ [WebSocket] Error:', err);
  });
});

// === Start server ===
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
  console.log('🎉 Your service is live');
});
