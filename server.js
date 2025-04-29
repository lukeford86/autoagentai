// server.js
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

// Enable CORS + body-parsing (just in case)
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

////////////////////////////////////////////////////////////////////////////////
// 1) HEALTH CHECK
////////////////////////////////////////////////////////////////////////////////
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  res.send('✅ AI Call Server is live');
});

////////////////////////////////////////////////////////////////////////////////
// 2) TWIML ENDPOINT
////////////////////////////////////////////////////////////////////////////////
app.all('/twiml', (req, res) => {
  // Twilio will GET this URL
  const params = req.method === 'POST' ? req.body : req.query;
  console.log('➡️ [TwiML] Received /twiml request:', params);

  const { agent_id, voice_id, contact_name, address } = params;
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] missing required fields');
    return res.status(400).send('Missing required fields');
  }

  // Build a plain WS URL
  const rawWsUrl = `wss://${req.headers.host}/media?` +
    `agent_id=${encodeURIComponent(agent_id)}` +
    `&voice_id=${encodeURIComponent(voice_id)}` +
    `&contact_name=${encodeURIComponent(contact_name)}` +
    `&address=${encodeURIComponent(address)}`;
  console.log('🔗 [TwiML] raw WS URL:', rawWsUrl);

  // Escape ampersands for valid XML
  const xmlSafeWs = rawWsUrl.replace(/&/g, '&amp;');
  console.log('🔄 [TwiML] xml-safe WS URL:', xmlSafeWs);

  // Use <Connect><Stream> to send audio back INTO the call
  const twiml = `
<Response>
  <Connect>
    <Stream url="${xmlSafeWs}" />
  </Connect>
  <!-- Pause in case agent hangs up, etc -->
  <Pause length="60"/>
</Response>`.trim();

  console.log('✅ [TwiML] Sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

////////////////////////////////////////////////////////////////////////////////
// 3) WEBSOCKET UPGRADE HANDLING
////////////////////////////////////////////////////////////////////////////////
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('🔌 [Upgrade] incoming request:', req.url);
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws =>
      wss.emit('connection', ws, req)
    );
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// 4) WEBSOCKET CONNECTION → ElevenLabs STREAM
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', async (ws, req) => {
  console.log('✅ [WebSocket] Connection established:', req.url);

  // Parse query string out of req.url
  const query = new URLSearchParams(req.url.split('?')[1]);
  const agentId     = query.get('agent_id');
  const voiceId     = query.get('voice_id');
  const contactName = query.get('contact_name');
  const address     = query.get('address');
  console.log('🔍 [WebSocket] params:', { agentId, voiceId, contactName, address });

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [WebSocket] missing parameters → closing');
    return ws.close();
  }

  const text = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  console.log('✉️  [WebSocket] ElevenLabs TTS text:', text);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('❌ [WebSocket] ELEVENLABS_API_KEY not set');
    return ws.close();
  }

  try {
    const resp = await axios({
      method:       'post',
      url:          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers:      {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mulaw'
      },
      responseType: 'stream',
      data: {
        text,
        model_id:       'eleven_monolingual_v1',
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      }
    });

    resp.data.on('data', chunk => {
      console.log(`📦 [WebSocket] Streaming ${chunk.length} bytes to Twilio`);
      ws.send(chunk);
    });
    resp.data.on('end', () => {
      console.log('✅ [WebSocket] ElevenLabs stream ended');
      ws.close();
    });
  } catch (err) {
    console.error('💥 [WebSocket] ElevenLabs error:', err.response?.status, err.message);
    ws.close();
  }

  ws.on('message', m => console.log('📥 [WebSocket] Client message:', m));
  ws.on('close',   () => console.log('🛑 [WebSocket] Connection closed'));
  ws.on('error',   e => console.error('💥 [WebSocket] error:', e.message));
});

////////////////////////////////////////////////////////////////////////////////
// 5) START SERVER
////////////////////////////////////////////////////////////////////////////////
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
