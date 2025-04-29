// server.js
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const axios     = require('axios');

const app    = express();
const server = http.createServer(app);
const port   = process.env.PORT || 10000;

// parse form bodies so Twilio’s POST to /twiml can be inspected
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 1) Health check
app.get('/', (req, res) => {
  console.log('🔍 [Health] GET / → OK');
  res.send('✅ AI Call Server is live');
});

// 2) TwiML generator
app.all('/twiml', (req, res) => {
  // Twilio will POST you all of its call params here (Called, From, CallSid, etc)
  // BUT *your* custom fields came in on the query string of the URL you passed
  // when you created the outbound call:
  //    Url=https://…/twiml?agent_id=…&voice_id=…&contact_name=…&address=…
  //
  // We don’t actually need those query params in our Node code, we’ll bake them
  // into the Media Stream itself via <Parameter> below.
  console.log('➡️ [TwiML] got /twiml with', req.body);

  // pull nothing out of req.body other than sanity‐checking…
  // you could check req.body.CallSid etc if you want
  // for now assume it’s always valid.
  //
  // Build your WebSocket base URL (no querystring!)
  const wsUrl = `wss://${req.headers.host}/media`;

  // build a TwiML <Connect><Stream> with four <Parameter> children:
  const twiml = `
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="agent_id"      value="${req.query.agent_id      || ''}" />
      <Parameter name="voice_id"      value="${req.query.voice_id      || ''}" />
      <Parameter name="contact_name"  value="${req.query.contact_name  || ''}" />
      <Parameter name="address"       value="${req.query.address       || ''}" />
    </Stream>
  </Connect>
  <!-- fallback pause so call doesn’t drop immediately -->
  <Pause length="30"/>
</Response>`.trim();

  console.log('🔗 [TwiML] sending Connect/Stream with Parameters:');
  console.log('    agent_id     =', req.query.agent_id);
  console.log('    voice_id     =', req.query.voice_id);
  console.log('    contact_name =', req.query.contact_name);
  console.log('    address      =', req.query.address);

  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// 3) Wire up raw HTTP -> WS upgrade
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    console.log('🔌 [Upgrade] incoming WS upgrade to', req.url);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// 4) On each new media WS connection…
wss.on('connection', (ws, req) => {
  console.log('✅ [WebSocket] connected');

  let params = null;
  let callSid = null;

  // wait for the very first “start” message from Twilio:
  ws.once('message', chunk => {
    // it comes in as text JSON
    let msg;
    try {
      msg = JSON.parse(chunk.toString());
    } catch (err) {
      console.error('💥 [WebSocket] could not parse first message as JSON', err);
      return ws.close();
    }

    if (msg.event !== 'start' || !msg.start) {
      console.error('💥 [WebSocket] unexpected first event, closing', msg);
      return ws.close();
    }

    // grab your parameters out of the “start” event
    params = msg.start.parameters || {};
    callSid = msg.start.callSid || msg.start.streamSid;

    console.log('📡 [WebSocket] media-start event:');
    console.log('    callSid =', callSid);
    console.log('    parameters =', params);

    const { agent_id, voice_id, contact_name, address } = params;
    if (!agent_id || !voice_id || !contact_name || !address) {
      console.error('❌ [WebSocket] missing required parameters, closing');
      return ws.close();
    }

    // now we can call ElevenLabs and pipe audio into the WS
    streamTTS(agent_id, voice_id, contact_name, address, ws);
  });

  ws.on('close', code => console.log(`🛑 [WebSocket] closed (${code})`));
  ws.on('error', err =>   console.error('💥 [WebSocket] error:', err));
});

// helper: stream ElevenLabs TTS into an open WS
async function streamTTS(agentId, voiceId, name, addr, ws) {
  const text = `Hi ${name}, just confirming your appointment at ${addr}.`;
  console.log('✉️  [TTS] streaming text:', text);

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error('❌ [TTS] no ELEVENLABS_API_KEY in env, aborting');
    return ws.close();
  }

  try {
    const resp = await axios({
      method:       'post',
      url:          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers:      {
        'xi-api-key':   apiKey,
        'Content-Type': 'application/json',
        'Accept':       'audio/mulaw'
      },
      responseType: 'stream',
      data: {
        text,
        model_id:       'eleven_monolingual_v1',
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      }
    });

    resp.data.on('data', chunk => {
      console.log(`📦 [TTS] sending ${chunk.length} bytes of μ-law audio`);
      ws.send(chunk);
    });
    resp.data.on('end', () => {
      console.log('✅ [TTS] stream ended, closing WS');
      ws.close();
    });
  } catch (err) {
    console.error('💥 [TTS] error from ElevenLabs:', err.response?.status, err.message);
    ws.close();
  }
}

// 5) fire up the server
server.listen(port, () => {
  console.log(`🚀 AI Call Server listening on port ${port}`);
});
