// server.js
const express      = require('express');
const bodyParser   = require('body-parser');
const http         = require('http');
const WebSocket    = require('ws');
const { VoiceResponse } = require('twilio').twiml;

const app = express();
// parse application/x-www-form-urlencoded (Twilio will POST form data)
app.use(bodyParser.urlencoded({ extended: false }));

// optional healthcheck
app.get('/', (req, res) => res.send('OK'));

// TwiML endpoint
app.post('/twiml', (req, res) => {
  const agent_id     = req.query.agent_id;
  const voice_id     = req.query.voice_id;
  const contact_name = req.query.contact_name;
  const address      = req.query.address;

  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();
  // point Twilio's media Stream to our WS endpoint
  twiml.connect().stream({
    url: `${process.env.WS_URL || 'wss://' + req.headers.host}/media` +
         `?agent_id=${encodeURIComponent(agent_id)}` +
         `&voice_id=${encodeURIComponent(voice_id)}` +
         `&contact_name=${encodeURIComponent(contact_name)}` +
         `&address=${encodeURIComponent(address)}`,
  });
  // keep the call alive
  twiml.pause({ length: 3600 });

  res.type('text/xml').send(twiml.toString());
});

// create server & attach WS
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', (twilioWs, req) => {
  // parse out the customParameters we encoded in the TwiML URL
  const qs       = req.url.split('?')[1] || '';
  const params   = new URLSearchParams(qs);
  const agent_id     = params.get('agent_id');
  const voice_id     = params.get('voice_id');
  const contact_name = params.get('contact_name');
  const address      = params.get('address');

  console.log('[WS] Twilio stream opened with params:', { agent_id, voice_id, contact_name, address });

  // connect to your AI-agent websocket
  const aiUrl = `wss://autoagentai.onrender.com/media` +
                `?agent_id=${encodeURIComponent(agent_id)}` +
                `&voice_id=${encodeURIComponent(voice_id)}` +
                `&contact_name=${encodeURIComponent(contact_name)}` +
                `&address=${encodeURIComponent(address)}`;
  const aiWs = new WebSocket(aiUrl);

  aiWs.on('open',    () => console.log('[AI WS] connected'));
  aiWs.on('message', (msg) => {
    // relay AI audio frames back into Twilio
    twilioWs.send(msg);
  });
  aiWs.on('close',   () => {
    console.log('[AI WS] closed');
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  });

  // relay every Twilio media frame over to the AI service
  twilioWs.on('message', (data) => {
    if (aiWs.readyState === WebSocket.OPEN) {
      aiWs.send(data);
    }
  });

  // clean up when caller hangs up
  twilioWs.on('close', () => {
    console.log('[WS] Twilio client disconnected');
    if (aiWs.readyState === WebSocket.OPEN) aiWs.close();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
