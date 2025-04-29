// server.js
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

// Twilio & browser CORS + JSON parsing
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
  const params = req.method === 'POST' ? req.body : req.query;
  console.log('➡️ [TwiML] got /twiml with', params);

  const { agent_id, voice_id, contact_name, address } = params;
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] missing required fields');
    return res.status(400).send('Missing required fields');
  }

  // Build a path-based WebSocket URL so Twilio won’t mangle your querystring
  const p = [agent_id, voice_id, contact_name, address]
    .map(encodeURIComponent)
    .join('/');
  const rawWs = `wss://${req.headers.host}/media/${p}`;
  console.log('🔗 [TwiML] raw WS URL:', rawWs);

  const xmlSafe = rawWs.replace(/&/g, '&amp;');
  console.log('🔄 [TwiML] xml-safe WS URL:', xmlSafe);

  const twiml = `
<Response>
  <Connect>
    <Stream url="${xmlSafe}" />
  </Connect>
  <Pause length="60" />
</Response>`.trim();

  console.log('✅ [TwiML] sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

////////////////////////////////////////////////////////////////////////////////
// 3) WEBSOCKET UPGRADE
////////////////////////////////////////////////////////////////////////////////
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log(`🔌 [Upgrade] incoming: ${req.url}`);
  if (req.url.startsWith('/media/')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// 4) WEBSOCKET CONNECTION + ElevenLabs
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', async (ws, req) => {
  console.log('✅ [WebSocket] connected:', req.url);

  // /media/:agent/:voice/:contact/:address
  const parts = req.url.split('/').slice(2).map(decodeURIComponent);
  const [agentId, voiceId, contactName, address] = parts;
  console.log('🔍 [WebSocket] params:', { agentId, voiceId, contactName, address });

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [WebSocket] bad params, closing');
    return ws.close();
  }

  const msg = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  console.log('✉️  [WebSocket] ElevenLabs text:', msg);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('❌ [WebSocket] missing ELEVENLABS_API_KEY, closing');
    return ws.close();
  }

  try {
    const resp = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mulaw'
      },
      responseType: 'stream',
      data: {
        text: msg,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      }
    });

    resp.data.on('data', chunk => {
      console.log(`📦 [WS→Twilio] chunk ${chunk.length} bytes`);
      ws.send(chunk);
    });
    resp.data.on('end', () => {
      console.log('✅ [WS→Twilio] stream ended');
      ws.close();
    });
  } catch (err) {
    console.error('💥 [WebSocket] ElevenLabs error:', err.response?.status, err.message);
    ws.close();
  }

  ws.on('message', m => console.log('📥 [WebSocket] got message:', m));
  ws.on('close',   () => console.log('🛑 [WebSocket] closed'));
  ws.on('error',   e => console.error('💥 [WebSocket]', e.message));
});

////////////////////////////////////////////////////////////////////////////////
// 5) START SERVER
////////////////////////////////////////////////////////////////////////////////
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
