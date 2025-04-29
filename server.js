const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const app = express();

// Setup HTTP server manually for ws upgrade handling
const server = http.createServer(app);
const port = process.env.PORT || 10000;

// Allow CORS
app.use(cors());

// Route: Health check
app.get('/', (req, res) => {
  res.send('✅ AI Call Server is live');
});

// Route: TwiML endpoint
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  const wsUrl = `wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${contact_name}&address=${address}`;

  const twiml = `
    <Response>
      <Start>
        <Stream url="${wsUrl}" />
      </Start>
    </Response>
  `;

  console.log('✅ [TwiML] /twiml HIT');
  res.set('Content-Type', 'text/xml');
  res.send(twiml.trim());
});

// WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/media')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId = urlParams.get('agent_id');
  const voiceId = urlParams.get('voice_id');
  const contactName = urlParams.get('contact_name');
  const address = urlParams.get('address');

  console.log(`🎤 WebSocket connected for ${contactName} @ ${address}`);

  ws.on('message', (data) => {
    console.log('📥 Received WebSocket message (media chunk)');
    // In production: Send audio to ElevenLabs or transcription engine here
  });

  ws.on('close', () => {
    console.log('🛑 WebSocket closed');
  });

  ws.on('error', (err) => {
    console.error('💥 WebSocket error:', err.message);
  });
});

// Start server
server.listen(port, () => {
  console.log(`✅ AI Call Server running on port ${port}`);
});
