// src/server.js
require('dotenv').config();

const http             = require('http');
const express          = require('express');
const bodyParser       = require('body-parser');
const WebSocket        = require('ws');
const { VoiceResponse } = require('twilio').twiml;

const app    = express();
const server = http.createServer(app);

// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/', (_req, res) => res.send('OK'));

app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();

  // 1) Speak the confirmation:
  twiml.say(`Hi ${contact_name}, just confirming your appointment at ${address}.`);

  // 2) Now open the Media Stream:
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `wss://${req.headers.host}/media` });
  stream.parameter({ name: 'agent_id',     value: agent_id });
  stream.parameter({ name: 'voice_id',     value: voice_id });
  stream.parameter({ name: 'contact_name', value: contact_name });
  stream.parameter({ name: 'address',      value: address });

  // 3) keep the call alive for 30s so we can capture inbound:
  twiml.pause({ length: 30 });

  res.type('text/xml').send(twiml.toString());
});


const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws) => {
  console.log('[WebSocket] client connected');

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); }
    catch (e) { return console.error('invalid JSON', e); }

    switch (msg.event) {
      case 'connected':
        console.log('📡 raw event:', msg);
        break;
      case 'start':
        console.log('📡 raw event:', msg);
        console.log('   • callSid:', msg.start.callSid);
        console.log('   • parameters:', msg.start.customParameters);
        break;
      case 'media':
        console.log(`📡 got media chunk: ${msg.media.chunk}`);
        break;
      default:
        console.log('📡 unhandled event:', msg.event);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[WebSocket] closed ${code}`, reason);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    console.log('[Upgrade] incoming WS upgrade to', req.url);
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('==> Your service is live 🎉');
});
