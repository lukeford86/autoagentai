// server.js
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

// parse bodies & allow Twilio’s CORS
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
  // Twilio might GET or POST
  const params = req.method === 'POST' ? req.body : req.query;
  console.log('➡️ [TwiML] got /twiml with', params);

  const { agent_id, voice_id, contact_name, address } = params;
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] missing one of agent_id,voice_id,contact_name,address');
    return res.status(400).send('Missing required fields');
  }

  // build a PATH-based WS URL so we never rely on query-string parsing
  const cleanAgent     = encodeURIComponent(agent_id);
  const cleanVoice     = encodeURIComponent(voice_id);
  const cleanContact   = encodeURIComponent(contact_name);
  const cleanAddress   = encodeURIComponent(address);

  const rawWsUrl = `wss://${req.headers.host}` +
    `/media/${cleanAgent}/${cleanVoice}/${cleanContact}/${cleanAddress}`;
  console.log('🔗 [TwiML] raw WS URL:', rawWsUrl);

  // escape ampersands (none here!) but in case your host contains &
  const xmlSafeUrl = rawWsUrl.replace(/&/g, '&amp;');
  console.log('🔄 [TwiML] xml-safe WS URL:', xmlSafeUrl);

  const twiml = `
<Response>
  <Connect>
    <Stream url="${xmlSafeUrl}" />
  </Connect>
  <!-- Hold the call open for up to 60s so your AI audio gets injected: -->
  <Pause length="60"/>
</Response>`.trim();

  console.log('✅ [TwiML] sending to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

////////////////////////////////////////////////////////////////////////////////
// 3) WEBSOCKET UPGRADE  → only /media/*
////////////////////////////////////////////////////////////////////////////////
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log(`🔌 [Upgrade] incoming: ${req.url}`);
  if (req.url.startsWith('/media/')) {
    console.log('🛠 [Upgrade] handling /media WS upgrade');
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    console.log('❌ [Upgrade] not /media – destroying socket');
    socket.destroy();
  }
});

////////////////////////////////////////////////////////////////////////////////
// 4) WS CONNECTION → parse path segments, stream from ElevenLabs
////////////////////////////////////////////////////////////////////////////////
wss.on('connection', async (ws, req) => {
  console.log('✅ [WebSocket] connected:', req.url);

  // path: /media/:agent/:voice/:contact/:address
  const parts = req.url.split('/').slice(2); // [agent, voice, contact, address]
  const [agentId, voiceId, contactName, address] = parts.map(decodeURIComponent);

  console.log('🔍 [WebSocket] parsed params:', {
    agentId, voiceId, contactName, address
  });

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [WebSocket] missing params → closing');
    return ws.close();
  }

  // craft your message
  const aiText = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  console.log('✉️  [WebSocket] will send to ElevenLabs:', aiText);

  try {
    const resp = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mulaw',
      },
      responseType: 'stream',
      data: {
        text: aiText,
        model_id: 'eleven_monolingual_v1',
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      }
    });

    resp.data.on('data', chunk => {
      console.log(`📦 [WS→Twilio] sending chunk ${chunk.length} bytes`);
      ws.send(chunk);
    });

    resp.data.on('end', () => {
      console.log('✅ [WS→Twilio] ElevenLabs stream ended → closing WS');
      ws.close();
    });

  } catch (err) {
    console.error('💥 [WebSocket] ElevenLabs error:', err.response?.status, err.message);
    ws.close();
  }

  ws.on('message', msg => console.log('📥 [WebSocket] got message:', msg));
  ws.on('close', () => console.log('🛑 [WebSocket] closed'));
  ws.on('error', e => console.error('💥 [WebSocket] error:', e.message));
});

////////////////////////////////////////////////////////////////////////////////
// 5) LAUNCH
////////////////////////////////////////////////////////////////////////////////
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
