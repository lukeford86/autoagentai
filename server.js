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
  // these come from the URL you set on your Calls.create()
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  const host = req.headers.host;
  const wsBase = process.env.WS_URL || `wss://${host}/media`;

  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: wsBase });

  // 👇— here’s the critical bit: use <Parameter> tags so Twilio populates start.customParameters
  stream.parameter({ name: 'agent_id',     value: agent_id     });
  stream.parameter({ name: 'voice_id',     value: voice_id     });
  stream.parameter({ name: 'contact_name', value: contact_name });
  stream.parameter({ name: 'address',      value: address      });

  // keep the call alive while you proxy the WebSocket
  twiml.pause({ length: 3600 });

  res.type('text/xml').send(twiml.toString());
});

// make a single HTTP + WS server
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  console.log('[WS] Twilio stream opened, waiting for start event…');
  let aiWs = null;

  twilioWs.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (_) { return; }

    if (msg.event === 'start') {
      const cp = msg.start.customParameters || {};
      console.log('[WS] start → customParameters:', cp);

      // now open your AI agent WS with those params in the query string
      const aiUrl = `wss://autoagentai.onrender.com/media?` +
                    new URLSearchParams(cp).toString();

      aiWs = new WebSocket(aiUrl);
      aiWs.on('open',    ()        => console.log('[AI WS] connected'));
      aiWs.on('message', data      => twilioWs.send(data));
      aiWs.on('close',   ()        => {
        console.log('[AI WS] closed');
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      });
      return;
    }

    // proxy all media frames after start
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
