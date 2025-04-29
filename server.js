// src/server.js
const express       = require('express');
const { urlencoded }= require('express');
const http          = require('http');
const WebSocket     = require('ws');
const { twiml: { VoiceResponse } } = require('twilio');

const app = express();

// 1) parse application/x-www-form-urlencoded (Twilio POSTS this)
app.use(urlencoded({ extended: true }));

// 2) Your TwiML webhook
app.post('/twiml', (req, res) => {
  // Pull your custom params out of the query string (or body, if you ever choose)
  const params = {
    agent_id:     req.query.agent_id     || req.body.agent_id,
    voice_id:     req.query.voice_id     || req.body.voice_id,
    contact_name: req.query.contact_name || req.body.contact_name,
    address:      req.query.address      || req.body.address,
  };

  console.log('[TwiML] Received:', params);

  // Build TwiML
  const response = new VoiceResponse();
  const connect  = response.connect();
  const stream   = connect.stream({ url: `wss://${req.headers.host}/media` });

  // Attach each parameter
  for (const [name, value] of Object.entries(params)) {
    stream.parameter({ name, value });
  }

  // Give yourself 30s to do the TTS / WebSocket dance
  stream.pause({ length: 30 });

  // Send back XML
  res.type('text/xml').send(response.toString());
});

// 3) Upgrade path for your media‐stream WebSocket
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', msg => {
        // handle media frames here…
      });
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
