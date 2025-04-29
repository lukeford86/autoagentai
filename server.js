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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  console.log('🔍 [Health] /');
  res.send('✅ AI Call Server is live');
});

// ─── TwiML endpoint ───────────────────────────────────────────────────────────
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('➡️ [TwiML] Received:', req.query);

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] Missing required fields');
    return res.status(400).send('Missing required fields');
  }

  // build &-escaped WebSocket URL
  const raw = 
    `wss://${req.headers.host}/media?` +
    `agent_id=${encodeURIComponent(agent_id)}` +
    `&voice_id=${encodeURIComponent(voice_id)}` +
    `&contact_name=${encodeURIComponent(contact_name)}` +
    `&address=${encodeURIComponent(address)}`;
  console.log('🔗 [TwiML] raw WS URL:', raw);

  const xmlSafe = raw.replace(/&/g, '&amp;');
  console.log('🔄 [TwiML] xmlSafe WS URL:', xmlSafe);

  // use <Connect> so audio you send back on the WS is played into the call
  const twiml = `
<Response>
  <Connect>
    <Stream url="${xmlSafe}" />
  </Connect>
  <Pause length="60"/>
</Response>`.trim();

  res.set('Content-Type', 'text/xml');
  console.log('✅ [TwiML] sending TwiML');
  res.send(twiml);
});

// ─── WebSocket + Media Streams ─────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  console.log('⏫ [Upgrade] incoming request:', req.url);
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  console.log('✔️  [WebSocket] connected:', req.url);

  // un-escape &amp; → &
  const cleaned = req.url.replace(/&amp;/g, '&');
  console.log('🔄 [WebSocket] cleaned URL:', cleaned);

  const params      = new URLSearchParams(cleaned.replace('/media?', ''));
  const agentId     = params.get('agent_id');
  const voiceId     = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address     = params.get('address');

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [WebSocket] missing params:', { agentId, voiceId, contactName, address });
    ws.close(1008, 'Missing params');
    return;
  }

  console.log(`🗣️  [WebSocket] streaming for "${contactName}" @ "${address}"`);
  const aiText       = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  const apiKey       = process.env.ELEVENLABS_API_KEY;
  console.log('✏️  [ElevenLabs] text:', aiText);

  try {
    const response = await axios({
      method: 'post',
      url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers:{
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mulaw'
      },
      responseType: 'stream',
      data: {
        text:           aiText,
        model_id:       'eleven_monolingual_v1',
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      }
    });

    response.data.on('data', chunk => {
      console.log(`📤 [WebSocket] sending ${chunk.length} bytes`);
      ws.send(chunk);
    });
    response.data.on('end', () => {
      console.log('✅ [ElevenLabs] stream ended → closing WS');
      ws.close();
    });

  } catch (err) {
    console.error('💥 [ElevenLabs] error:', err.response?.status, err.message);
    ws.close(1011, 'TTS error');
  }

  ws.on('message', () => console.log('📥 [WebSocket] incoming media chunk'));
  ws.on('close',   (code, reason) => console.log(`🛑 [WebSocket] closed code=${code} reason="${reason}"`));
  ws.on('error',   err => console.error('🔴 [WebSocket] error:', err.message));
});

// ─── Listen ────────────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
