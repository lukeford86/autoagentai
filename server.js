// server.js
require('dotenv').config();

const http         = require('http');
const express      = require('express');
const bodyParser   = require('body-parser');
const WebSocket    = require('ws');
const { VoiceResponse } = require('twilio').twiml;

const app  = express();
const server = http.createServer(app);

// parse application/x-www-form-urlencoded for Twilio webhooks
app.use(bodyParser.urlencoded({ extended: false }));

// Health-check endpoint (optional)
app.get('/', (_req, res) => res.send('OK'));

// TwiML webhook: responds with <Connect><Stream> + <Pause>
app.post('/twiml', (req, res) => {
  // Twilio will preserve your query-string params in req.query
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received:', { agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: `wss://${req.headers.host}/media` });

  // attach your four custom parameters
  stream.parameter({ name: 'agent_id',      value: agent_id });
  stream.parameter({ name: 'voice_id',      value: voice_id });
  stream.parameter({ name: 'contact_name',  value: contact_name });
  stream.parameter({ name: 'address',       value: address });

  // now pause for 30s at the *top level*
  twiml.pause({ length: 30 });

  res.type('text/xml').send(twiml.toString());
});

// WebSocket server for Twilio Media Streams
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] connected`);

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      console.error('[WebSocket] invalid JSON:', err);
      return;
    }

    switch (msg.event) {
      case 'connected':
        console.log('📡 raw event:', msg);
        break;

      case 'start':
        console.log('📡 raw event:', msg);
        const { customParameters, streamSid, callSid } = msg.start;
        console.log(`   • callSid: ${callSid}`);
        console.log('   • parameters:', customParameters);
        // TODO: kick off your TTS or NLP here, e.g.
        // const { agent_id, voice_id, contact_name, address } = customParameters;
        // do something with them…
        break;

      case 'media':
        // Twilio is streaming you audio chunks (µ-law base64)
        // You can parse msg.media.payload, process STT, etc.
        console.log('📡 [WebSocket] got media chunk:', msg.media.chunk);
        break;

      default:
        console.log('📡 [WebSocket] raw event:', msg);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[WebSocket] closed ${code}`, reason || '');
  });
});

// Upgrade HTTP → WS on /media
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media') {
    console.log('[Upgrade] incoming WS upgrade to', req.url);
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// start listening
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`\nServer listening on port ${PORT}`);
  console.log('==> Your service is live 🎉');
});
