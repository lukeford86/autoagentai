// server.js

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const server = http.createServer(app);
const port = process.env.PORT || 10000;

// Helper to escape XML entities
function escapeXml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

// Health-check endpoint
app.get('/', (req, res) => {
  console.log('🔍 Health check');
  res.send('✅ AI Call Server is live');
});

// TwiML endpoint (handles both GET and POST)
app.all('/twiml', (req, res) => {
  console.log('➡️ Received /twiml request:', req.query);

  const { agent_id, voice_id, contact_name, address } = req.query;
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  // Build and escape the WebSocket URL
  const rawWsUrl = `wss://${req.headers.host}/media?agent_id=${agent_id}` +
                   `&voice_id=${voice_id}` +
                   `&contact_name=${encodeURIComponent(contact_name)}` +
                   `&address=${encodeURIComponent(address)}`;
  console.log('🔗 Constructed WebSocket URL:', rawWsUrl);

  const wsUrl = escapeXml(rawWsUrl);
  console.log('🔄 Escaped WebSocket URL for XML:', wsUrl);

  // Return the TwiML
  const twiml = `
    <Response>
      <Start>
        <Stream url="${wsUrl}" />
      </Start>
    </Response>
  `.trim();

  console.log('✅ [TwiML] Sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// WebSocket server (for Twilio Media Streams)
const wss = new WebSocket.Server({ noServer: true });

// Log and handle HTTP → WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  console.log('🔄 [Upgrade] incoming request:', req.method, req.url);
  if (req.url.startsWith('/media')) {
    console.log('➡️ [Upgrade] handling WebSocket upgrade');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    console.warn('❌ [Upgrade] unknown path, destroying socket:', req.url);
    socket.destroy();
  }
});

// When Twilio connects the media stream:
wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId    = params.get('agent_id');
  const voiceId    = params.get('voice_id');
  const contactName= params.get('contact_name');
  const address    = params.get('address');

  console.log(`✅ [WebSocket] Connection established for ${contactName} @ ${address}`);

  // Generate your AI message
  const aiMessage = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;

  // Stream ElevenLabs TTS μ-law audio directly into the Twilio media stream
  axios({
    method: 'post',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    headers: {
      'xi-api-key': elevenLabsApiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mulaw'
    },
    responseType: 'stream',
    data: {
      text: aiMessage,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.75
      }
    }
  })
  .then(response => {
    console.log('🔊 Streaming ElevenLabs audio to Twilio...');
    response.data.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    });
    response.data.on('end', () => {
      console.log('✅ Finished streaming audio');
      ws.close();
    });
  })
  .catch(err => {
    console.error('💥 Error streaming from ElevenLabs:', err.message);
    ws.close();
  });

  // Log any incoming media (from caller)
  ws.on('message', (data) => {
    console.log('📥 [WebSocket] Received media chunk:', data.length, 'bytes');
    // Here you could forward to Deepgram or another STT engine
  });

  ws.on('close', () => {
    console.log('🛑 [WebSocket] Connection closed');
  });

  ws.on('error', (err) => {
    console.error('💥 [WebSocket] Error:', err.message);
  });
});

// Start the server
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
