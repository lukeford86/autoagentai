// server.js

const express = require('express');
const { Server } = require('ws');

const app = express();
const port = process.env.PORT || 10000;

// Create HTTP server
const server = app.listen(port, () => {
  console.log(`✅ AI Call Server running on port ${port}`);
  console.log('==> 🎉 Your service is live');
});

// Create WebSocket server
const wss = new Server({ noServer: true });

// Handle WebSocket connection upgrade
server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/media')) {
    console.log('✅ [UPGRADE] WebSocket Upgrade Request');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Handle WebSocket connection
wss.on('connection', (ws, request) => {
  console.log('✅ [WebSocket] Connection established');

  ws.on('message', (message) => {
    console.log('📥 [WebSocket Message Received]');
    // TODO: You can parse incoming media packets here if needed
  });

  ws.on('close', () => {
    console.log('❌ [WebSocket] Connection closed');
  });

  ws.on('error', (error) => {
    console.error('❌ [WebSocket] Error:', error);
  });
});

// TwiML endpoint
app.post('/twiml', (req, res) => {
  console.log('✅ [HTTP] /twiml HIT');

  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query params');
    return res.status(400).send('Missing required query parameters.');
  }

  const twimlResponse = `
    <Response>
      <Start>
        <Stream url="wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${contact_name}&address=${address}" />
      </Start>
    </Response>
  `;

  res.set('Content-Type', 'text/xml'); // <-- CRITICAL FIX
  res.status(200).send(twimlResponse);
});
