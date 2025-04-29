const express = require('express');
const http = require('http');
const { Server: WebSocketServer } = require('ws');
const { VoiceResponse } = require('twilio').twiml;
const url = require('url');

const PORT = process.env.PORT || 10000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// --- TwiML endpoint ---
app.all('/twiml', (req, res) => {
  console.log('✅ [HTTP] /twiml HIT');

  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${encodeURIComponent(agent_id)}&voice_id=${encodeURIComponent(voice_id)}&contact_name=${encodeURIComponent(contact_name)}&address=${encodeURIComponent(address)}`
  });

  res.type('text/xml');
  res.send(response.toString());
});

// --- WebSocket Upgrade Handler ---
server.on('upgrade', (request, socket, head) => {
  const pathname = url.parse(request.url).pathname;

  if (pathname === '/media') {
    console.log('✅ [UPGRADE] WebSocket upgrade to /media');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    console.warn('⚠️ [UPGRADE] Unknown path', pathname);
    socket.destroy();
  }
});

// --- WebSocket Connection Handler ---
wss.on('connection', (ws, request) => {
  console.log('✅ [WebSocket] Connection established');

  ws.on('message', (message) => {
    console.log('📥 [WebSocket] Message received', message.length, 'bytes');
    // This is where incoming audio/media can be handled later
  });

  ws.on('close', () => {
    console.log('❌ [WebSocket] Connection closed');
  });

  ws.on('error', (error) => {
    console.error('❌ [WebSocket] Error', error);
  });
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
