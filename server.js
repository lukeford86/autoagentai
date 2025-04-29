// server.js
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

// 1) middleware
app.use(cors());
app.use(express.urlencoded({ extended: true })); // parse Twilio POST bodies
app.use(express.json());

// 2) health check
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  res.send('✅ AI Call Server is live');
});

// 3) TwiML endpoint
app.all('/twiml', (req, res) => {
  // merge query + body so we grab agent_id whether Twilio POSTS or GETs
  const params = { ...req.query, ...req.body };
  console.log('➡️ [TwiML] got /twiml with', params);

  const { agent_id, voice_id, contact_name, address } = params;
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] missing required fields');
    return res.status(400).send('Missing required fields');
  }

  // build and escape your WebSocket URL
  const rawWs = `wss://${req.headers.host}/media?` +
    `agent_id=${encodeURIComponent(agent_id)}` +
    `&voice_id=${encodeURIComponent(voice_id)}` +
    `&contact_name=${encodeURIComponent(contact_name)}` +
    `&address=${encodeURIComponent(address)}`;
  console.log('🔗 [TwiML] raw WS URL:', rawWs);

  const xmlSafeWs = rawWs.replace(/&/g, '&amp;');
  console.log('🔄 [TwiML] xml-safe WS URL:', xmlSafeWs);

  // <-- use Connect to send audio *into* the call -->
  const twiml = `
<Response>
  <Connect>
    <Stream url="${xmlSafeWs}" />
  </Connect>
  <Pause length="60"/>
</Response>`.trim();

  console.log('✅ [TwiML] sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// 4) WebSocket upgrade
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('🔌 [Upgrade] incoming:', req.url);
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// 5) WebSocket logic → ElevenLabs
wss.on('connection', async (ws, req) => {
  console.log('✅ [WebSocket] connected:', req.url);
  const qp = new URLSearchParams(req.url.split('?')[1]);
  const agentId     = qp.get('agent_id');
  const voiceId     = qp.get('voice_id');
  const contactName = qp.get('contact_name');
  const address     = qp.get('address');
  console.log('🔍 [WebSocket] params:', { agentId, voiceId, contactName, address });

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [WebSocket] missing params → closing');
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
      console.log(`📦 [WebSocket] sending ${chunk.length} bytes`);
      ws.send(chunk);
    });
    resp.data.on('end', () => {
      console.log('✅ [WebSocket] stream ended');
      ws.close();
    });
  } catch (err) {
    console.error('💥 [WebSocket] ElevenLabs error:', err.response?.status, err.message);
    ws.close();
  }

  ws.on('message', msg  => console.log('📥 [WebSocket] message:', msg));
  ws.on('close',       ()   => console.log('🛑 [WebSocket] closed'));
  ws.on('error',       e    => console.error('💥 [WebSocket] error:', e.message));
});

// 6) listen
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
