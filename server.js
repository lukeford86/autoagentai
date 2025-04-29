// server.js
const express = require('express');
const http = require('http');
const { VoiceResponse } = require('twilio').twiml;
const WebSocket = require('ws');

const app = express();

// Parse application/x-www-form-urlencoded (what Twilio POSTs to /twiml)
app.use(express.urlencoded({ extended: true }));

// Your TwiML endpoint
app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.body;
  console.log('➡️ [TwiML] Received:', { agent_id, voice_id, contact_name, address });

  // Build a <Say> response
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'alice', language: 'en-US' },
    `Hi ${contact_name}, just confirming your appointment at ${address}.`
  );

  res.type('text/xml').send(twiml.toString());
});

// (Optional) WebSocket server if you want to receive caller audio via <Connect><Stream>
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', ws => {
  console.log('✅ [WebSocket] connected');

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return console.warn('⚠️ [WebSocket] non-JSON frame');
    }

    if (msg.event === 'start') {
      console.log('📡 [WebSocket] start payload:', JSON.stringify(msg.start, null, 2));
      // you can inspect: msg.start.customParameters, msg.start.streamSid, etc.
    }

    if (msg.event === 'media') {
      // Here you’ll get inbound audio chunks as base64.  You might
      // send them on to a speech-to-text service, etc.
      // console.log('📡 [WebSocket] got media chunk', msg.media.chunk);
    }
  });

  ws.on('close', code => console.log(`🛑 [WebSocket] closed ${code}`));
  ws.on('error', err => console.error('❌ [WebSocket] error', err));
});

// start both HTTP + WS on same port
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
