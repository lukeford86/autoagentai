// server.js
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 1) Health check
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  res.send('✅ AI Call Server is live');
});

// 2) TwiML generator: <Connect><Stream> + <Parameter>
app.all('/twiml', (req, res) => {
  console.log('➡️ [TwiML] got /twiml with', req.body);

  const wsBase = `wss://${req.headers.host}/media`;
  const params = {
    agent_id:     req.query.agent_id     || '',
    voice_id:     req.query.voice_id     || '',
    contact_name: req.query.contact_name || '',
    address:      req.query.address      || ''
  };

  // Basic validation:
  if (!params.agent_id || !params.voice_id || !params.contact_name || !params.address) {
    console.error('❌ [TwiML] Missing one of agent_id, voice_id, contact_name, address');
    return res.status(400).send('Missing required fields');
  }

  // Build TwiML
  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsBase}">
      <Parameter name="agent_id"      value="${params.agent_id}" />
      <Parameter name="voice_id"      value="${params.voice_id}" />
      <Parameter name="contact_name"  value="${params.contact_name}" />
      <Parameter name="address"       value="${params.address}" />
    </Stream>
  </Connect>
  <Pause length="30"/>
</Response>`.trim();

  console.log('🔗 [TwiML] sending Connect/Stream with Parameters:', params);
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// 3) WebSocket upgrade
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    console.log('🔌 [Upgrade] incoming WS upgrade to', req.url);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// 4) WS connection handler
wss.on('connection', (ws, req) => {
  console.log('✅ [WebSocket] connected');

  ws.on('message', chunk => {
    let msg;
    try {
      msg = JSON.parse(chunk.toString());
    } catch (err) {
      console.warn('⚠️ [WebSocket] non-JSON message – ignoring');
      return;
    }

    console.log('📡 [WebSocket] got event:', msg.event);
    if (msg.event === 'connected') {
      // Twilio’s handshake – ignore
      return;
    }

    if (msg.event === 'start' && msg.start) {
      const p = msg.start.parameters || {};
      const callSid = msg.start.callSid || msg.start.streamSid;
      console.log('    • callSid:', callSid);
      console.log('    • parameters:', p);

      const { agent_id, voice_id, contact_name, address } = p;
      if (!agent_id || !voice_id || !contact_name || !address) {
        console.error('❌ [WebSocket] missing parameters – closing');
        return ws.close();
      }

      // Kick off TTS
      streamTTS(agent_id, voice_id, contact_name, address, ws);
      return;
    }

    // We could also log inbound RTP frames (msg.event==='media'), but we don't need them
  });

  ws.on('close', code => console.log(`🛑 [WebSocket] closed (${code})`));
  ws.on('error', err => console.error('💥 [WebSocket] error:', err.message));
});

// 5) TTS streaming helper
async function streamTTS(agentId, voiceId, name, addr, ws) {
  const text = `Hi ${name}, just confirming your appointment at ${addr}.`;
  console.log('✉️  [TTS] streaming:', text);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('❌ [TTS] ELEVENLABS_API_KEY not set');
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

server.listen(port, () => {
  console.log(`🚀 AI Call Server listening on port ${port}`);
});
