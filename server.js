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

// Health check
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  return res.send('✅ AI Call Server is live');
});

// TwiML endpoint
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('➡️ [TwiML] Received:', req.query);

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ [TwiML] missing required fields');
    return res.status(400).send('Missing required fields');
  }

  // Build a bare WS URL (we’ll pass params in <Parameter> tags)
  const rawWsUrl   = `wss://${req.headers.host}/media`;
  const xmlSafeUrl = rawWsUrl.replace(/&/g, '&amp;');

  // TwiML: Connect→Stream + Parameter tags
  const xml = `
    <Response>
      <Connect>
        <Stream url="${xmlSafeUrl}">
          <Parameter name="agent_id"     value="${agent_id}"     />
          <Parameter name="voice_id"     value="${voice_id}"     />
          <Parameter name="contact_name" value="${contact_name}" />
          <Parameter name="address"      value="${address}"      />
        </Stream>
      </Connect>
      <Pause length="60"/>
    </Response>
  `.trim();

  console.log('🔗 [TwiML] sending Connect/Stream w/ params:', {
    agent_id, voice_id, contact_name, address
  });

  res.set('Content-Type', 'text/xml');
  res.send(xml);
});

// WebSocket server (for Twilio Media Streams)
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

wss.on('connection', ws => {
  console.log('✅ [WebSocket] connected');

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.warn('⚠️ [WebSocket] non-JSON frame:', raw);
      return;
    }
    console.log('📡 [WebSocket] raw event:', msg);

    // Twilio first sends a "connected" event, then a "start" event
    if (msg.event === 'start') {
      // Twilio may put your <Parameter> tags under msg.customParameters
      // or under msg.start.customParameters depending on regions/versions
      const params =
        msg.customParameters ||
        (msg.start && msg.start.customParameters) ||
        msg.parameters ||
        {};
      const callSid =
        msg.streamSid || msg.callSid || (msg.start && msg.start.streamSid);

      console.log('   • callSid:', callSid);
      console.log('   • parameters:', params);

      const { agent_id, voice_id, contact_name, address } = params;
      if (!agent_id || !voice_id || !contact_name || !address) {
        console.error('❌ [WebSocket] missing params → closing', params);
        return ws.close();
      }

      // Kick off ElevenLabs TTS
      const text = `Hi ${contact_name}, just confirming your appointment at ${address}.`;
      console.log('📝 [TTS] requesting for:', text);

      try {
        const response = await axios({
          method: 'post',
          url: `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}/stream`,
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
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

        response.data.on('data', chunk => {
          console.log(`📦 [TTS] streaming ${chunk.length} bytes`);
          ws.send(chunk);
        });
        response.data.on('end', () => {
          console.log('✅ [TTS] finished, closing WS');
          ws.close();
        });
      } catch (err) {
        console.error('❌ [TTS] ElevenLabs error:', err.response?.status, err.message);
        ws.close();
      }
    }

    // Optionally handle inbound media ('media' events) here…
  });

  ws.on('close',   (code, reason) => console.log('🛑 [WebSocket] closed', code, reason));
  ws.on('error',   err          => console.error('💥 [WebSocket] error', err.message));
});

server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
