// server.js
require('dotenv').config();            // optional, if you use a .env
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

app.use(cors());

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  res.send('✅ AI Call Server is live');
});

// ─── TwiML Endpoint ────────────────────────────────────────────────────────────
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('➡️ [TwiML] Received:', req.query);

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] missing required fields');
    return res.status(400).send('Missing required fields');
  }

  // Build WS URL (no params here—Twilio will inject them via <Parameter/>)
  const rawWsUrl = `wss://${req.headers.host}/media`;
  // Escape & just in case
  const xmlSafeWsUrl = rawWsUrl.replace(/&/g, '&amp;');

  // TwiML with Connect→Stream+Parameters
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${xmlSafeWsUrl}">
          <Parameter name="agent_id"     value="${agent_id}" />
          <Parameter name="voice_id"     value="${voice_id}" />
          <Parameter name="contact_name" value="${contact_name}" />
          <Parameter name="address"      value="${address}" />
        </Stream>
      </Connect>
      <!-- put the caller on quiet hold while TTS streams -->
      <Pause length="60"/>
    </Response>`.trim();

  console.log('🔗 [TwiML] sending Connect/Stream w/ params:', {
    agent_id, voice_id, contact_name, address
  });

  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    console.log('🔄 [Upgrade] incoming WS upgrade to', req.url);
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws /*, req */) => {
  console.log('✅ [WebSocket] connected');

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.warn('⚠️ [WebSocket] non-JSON message, ignoring');
      return;
    }

    console.log('📡 [WebSocket] got event:', msg.event);

    // — handle the “start” event (should carry your <Parameter/> values)
    if (msg.event === 'start') {
      const params = msg.customParameters || msg.customparameters || {};
      console.log('   • callSid:', msg.streamSid || msg.callSid);
      console.log('   • parameters:', params);

      const { agent_id, voice_id, contact_name, address } = params;
      if (!agent_id || !voice_id || !contact_name || !address) {
        console.error('❌ [WebSocket] missing parameters → closing', params);
        return ws.close();
      }

      // Now kick off your ElevenLabs TTS → send μ-law chunks back on ws.send(...)
      const text = `Hi ${contact_name}, just confirming your appointment at ${address}.`;
      console.log('📝 [TTS] generating:', text);

      try {
        const elevenKey = process.env.ELEVENLABS_API_KEY;
        const resp = await axios({
          method: 'post',
          url: `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`,
          headers: {
            'xi-api-key': elevenKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mulaw'
          },
          responseType: 'stream',
          data: {
            text,
            model_id: 'eleven_monolingual_v1',
            voice_settings: { stability: 0.4, similarity_boost: 0.75 }
          }
        });

        resp.data.on('data', chunk => {
          console.log(`📦 [TTS] sending ${chunk.length} bytes`);
          ws.send(chunk);
        });
        resp.data.on('end', () => {
          console.log('✅ [TTS] done, closing WS');
          ws.close();
        });
      } catch (err) {
        console.error('❌ [TTS] ElevenLabs error:', err.response?.status, err.message);
        ws.close();
      }

    // — optional: log inbound media frames if you ever want speech recognition
    } else if (msg.event === 'media') {
      // console.log('🎙 [WebSocket] inbound media, length=', msg.media.payload.length);
    }
  });

  ws.on('close',   (code, reason) => console.log('🛑 [WebSocket] closed', code, reason));
  ws.on('error',   err          => console.error('💥 [WebSocket] error', err.message));
});

server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
