// server.js
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');
// if you want local .env support, do:
//   npm install dotenv
//   require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── 1) Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  res.send('✅ AI Call Server is live');
});

// ─── 2) TwiML endpoint ──────────────────────────────────────────────────────────
app.all('/twiml', (req, res) => {
  console.log('➡️ [TwiML] got /twiml with', req.body);

  const { agent_id, voice_id, contact_name, address } = req.query;
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] Missing one of agent_id, voice_id, contact_name, address');
    return res.status(400).send('Missing required fields');
  }

  const wsUrl = `wss://${req.headers.host}/media`;

  // Build TwiML with <Parameter> tags
  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="agent_id"     value="${agent_id}"      />
      <Parameter name="voice_id"     value="${voice_id}"      />
      <Parameter name="contact_name" value="${contact_name}"  />
      <Parameter name="address"      value="${address}"       />
    </Stream>
  </Connect>
  <Pause length="30"/>
</Response>`.trim();

  console.log('🔗 [TwiML] sending Connect/Stream with:', {
    agent_id, voice_id, contact_name, address
  });

  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ─── 3) WebSocket upgrade handling ───────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    console.log('🛠️ [Upgrade] incoming WS upgrade to', req.url);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ─── 4) WebSocket connection ────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  console.log('✅ [WebSocket] connected');

  ws.on('message', chunk => {
    let msg;
    try {
      msg = JSON.parse(chunk.toString());
    } catch {
      console.warn('⚠️ [WebSocket] non-JSON chunk, ignoring');
      return;
    }

    console.log('📡 [WebSocket] got event:', msg.event);

    // 1st handshake
    if (msg.event === 'connected') {
      return;
    }

    // actual start event
    if (msg.event === 'start' && msg.start) {
      const { callSid, parameters } = msg.start;
      console.log('    • callSid:', callSid);
      console.log('    • parameters:', parameters);

      const { agent_id, voice_id, contact_name, address } = parameters || {};
      if (!agent_id || !voice_id || !contact_name || !address) {
        console.error('❌ [WebSocket] missing parameters – closing');
        return ws.close();
      }

      // kick off TTS
      return streamTTS(agent_id, voice_id, contact_name, address, ws);
    }

    // anything else (media frames, etc) we simply log
    if (msg.event === 'media') {
      console.log('🎙️ [WebSocket] got media frame, length =', msg.media.payload.length);
    }
  });

  ws.on('close', code => console.log(`🛑 [WebSocket] closed (${code})`));
  ws.on('error', err => console.error('💥 [WebSocket] error:', err.message));
});

// ─── 5) ElevenLabs TTS streaming ────────────────────────────────────────────────
async function streamTTS(agentId, voiceId, name, addr, ws) {
  const text = `Hi ${name}, just confirming your appointment at ${addr}.`;
  console.log('✉️  [TTS] streaming:', text);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('❌ [TTS] ELEVENLABS_API_KEY missing');
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
      console.log(`📦 [TTS] sending ${chunk.length} bytes`);
      ws.send(chunk);
    });
    resp.data.on('end', () => {
      console.log('✅ [TTS] complete – closing WS');
      ws.close();
    });
  } catch (err) {
    console.error('💥 [TTS] ElevenLabs error:', err.response?.status, err.message);
    ws.close();
  }
}

// ─── boot up ────────────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log(`🚀 AI Call Server listening on port ${port}`);
});
