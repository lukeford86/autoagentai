// server.js

const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const cors        = require('cors');
const axios       = require('axios');
const { URL }     = require('url');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

app.use(cors());

// ─── Health check ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  console.log('🔍 Health check');
  res.send('✅ AI Call Server is live');
});

// ─── TwiML endpoint ─────────────────────────────────────────────────────────────
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('➡️ Received /twiml request:', { agent_id, voice_id, contact_name, address });

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  // build raw WS URL
  const host = req.headers.host;
  const rawWsUrl = `wss://${host}/media`
    + `?agent_id=${encodeURIComponent(agent_id)}`
    + `&voice_id=${encodeURIComponent(voice_id)}`
    + `&contact_name=${encodeURIComponent(contact_name)}`
    + `&address=${encodeURIComponent(address)}`;

  console.log('🔗 Constructed WebSocket URL:', rawWsUrl);

  // escape ampersands for XML
  const xmlSafe = rawWsUrl.replace(/&/g, '&amp;');
  console.log('🔄 XML-escaped WebSocket URL for TwiML:', xmlSafe);

  const twiml = `
<Response>
  <Connect>
    <Stream url="${xmlSafe}" />
  </Connect>
  <!-- keep the call open while streaming -->
  <Pause length="60"/>
</Response>
`.trim();

  console.log('✅ [TwiML] Sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ─── WebSocket server ────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  console.log(`⬆️ [Upgrade] incoming request: ${req.url}`);
  if (req.url.startsWith('/media')) {
    console.log('➡️ [Upgrade] handling WebSocket upgrade');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  // parse query params out of the URL
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const agentId     = urlObj.searchParams.get('agent_id');
  const voiceId     = urlObj.searchParams.get('voice_id');
  const contactName = urlObj.searchParams.get('contact_name');
  const address     = urlObj.searchParams.get('address');

  console.log(`✅ [WebSocket] Connection established for ${contactName} @ ${address}`);

  const aiMessage       = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  const elevenLabsKey   = process.env.ELEVENLABS_API_KEY;
  console.log(`📤 [ElevenLabs] sending text to ElevenLabs: ${aiMessage}`);

  try {
    const response = await axios({
      method:       'post',
      url:          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers: {
        'xi-api-key':    elevenLabsKey,
        'Content-Type':  'application/json',
        'Accept':        'audio/mulaw'
      },
      responseType: 'stream',
      data: {
        text:           aiMessage,
        model_id:       'eleven_monolingual_v1',
        voice_settings: {
          stability:       0.4,
          similarity_boost: 0.75
        }
      }
    });

    response.data.on('data', (chunk) => {
      console.log(`📡 [WebSocket] sending ${chunk.length} bytes of audio`);
      ws.send(chunk);
    });

    response.data.on('end', () => {
      console.log('✅ [ElevenLabs] Finished streaming audio');
      ws.close();
    });

  } catch (err) {
    console.error('💥 [ElevenLabs] Error streaming:', err.message);
    ws.close();
  }

  ws.on('message', (data) => {
    console.log(`📥 [WebSocket] received a message chunk (${data.length} bytes)`);
  });
  ws.on('close',   (code, reason) => {
    console.log(`🛑 [WebSocket] closed (code: ${code} reason: ${reason.toString()})`);
  });
  ws.on('error',   (err) => {
    console.error('💥 [WebSocket] error:', err.message);
  });
});

// ─── Start server ────────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
