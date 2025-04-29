// server.js
require('dotenv').config();

const express      = require('express');
const bodyParser   = require('body-parser');
const http         = require('http');
const WebSocket    = require('ws');
const { VoiceResponse } = require('twilio').twiml;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// healthcheck
app.get('/', (req, res) => res.send('OK'));

// TwiML endpoint
app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  const host = req.headers.host;
  const wsBase = process.env.WS_URL || `wss://${host}/media`;
  const params = new URLSearchParams({ agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();
  twiml
    .connect()
      .stream({ url: `${wsBase}?${params.toString()}` });
  // keep call alive while WS is open
  twiml.pause({ length: 3600 });

  res.type('text/xml').send(twiml.toString());
});

// create HTTP + WS server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  console.log('[WS] Twilio stream opened, waiting for start event…');

  let aiWs = null;

  twilioWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return;
    }

    // when Twilio tells us "start", grab its customParameters
    if (msg.event === 'start') {
      const cp = msg.start.customParameters || {};
      const params = {
        agent_id:     cp.agent_id,
        voice_id:     cp.voice_id,
        contact_name: cp.contact_name,
        address:      cp.address,
      };
      console.log('[WS] start→ customParameters:', params);

      // open your AI agent WS
      const aiUrl = `wss://autoagentai.onrender.com/media?` +
                    new URLSearchParams(params).toString();
      aiWs = new WebSocket(aiUrl);

      aiWs.on('open',    () => console.log('[AI WS] connected'));
      aiWs.on('message', (aiData) => { twilioWs.send(aiData); });
      aiWs.on('close',   () => {
        console.log('[AI WS] closed');
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      });

      return;
    }

    // forward all media frames to AI
    if (msg.event === 'media' && aiWs && aiWs.readyState === WebSocket.OPEN) {
      aiWs.send(raw);
    }
  });

  twilioWs.on('close', (code, reason) => {
    console.log('[WS] Twilio disconnected:', code, reason);
    if (aiWs && aiWs.readyState === WebSocket.OPEN) aiWs.close();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
