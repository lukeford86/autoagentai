// server.js
require('dotenv').config();

const express        = require('express');
const bodyParser     = require('body-parser');
const WebSocket      = require('ws');
const { VoiceResponse } = require('twilio').twiml;
const twilioClient   = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const { Deepgram }   = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI         = require('openai');

const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  PORT = 10000,
} = process.env;

// ————————————————————————————————————————————————————————————————
//  Sanity checks
// ————————————————————————————————————————————————————————————————
for (let key of ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing env var: ${key}`);
    process.exit(1);
  }
}

// ————————————————————————————————————————————————————————————————
//  SDK clients
// ————————————————————————————————————————————————————————————————
const dgClient   = new Deepgram(DEEPGRAM_API_KEY);
const eleven     = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai     = new OpenAI({ apiKey: OPENROUTER_API_KEY });

// ————————————————————————————————————————————————————————————————
//  Express + TwiML endpoint
// ————————————————————————————————————————————————————————————————
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Initial TwiML: Start inbound stream, Say the reminder, then Pause
app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] params:', { agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();
  // 1) Fork inbound audio into our WS
  twiml.start().stream({
    url:   `wss://${req.headers.host}/media`,
    track: 'inbound_track'
  });
  // 2) Say the reminder (this keeps the call open)
  twiml.say(
    { voice: 'Polly.Joanna' },
    `Hi ${contact_name}, just confirming your appointment at ${address}.`
  );
  // 3) Pause long enough for the customer to speak
  twiml.pause({ length: 600 });

  console.log('[TwiML XML]\n' + twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

// ————————————————————————————————————————————————————————————————
//  HTTP server + WebSocket upgrade
// ————————————————————————————————————————————————————————————————
const server = app.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}  (live)`);
});
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  console.log('[Upgrade] request for', req.url);
  if (req.url.startsWith('/media')) {
    console.log('[Upgrade] upgrading to WS');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    console.log('[Upgrade] non-media, destroying socket');
    socket.destroy();
  }
});

// ————————————————————————————————————————————————————————————————
//  Handle Twilio MediaStream messages
// ————————————————————————————————————————————————————————————————
wss.on('connection', (ws, req) => {
  console.log('[WS] Connection established, URL:', req.url);

  let dgSocket;
  let callSid;
  let voiceId, contactName, address, agentId;

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] invalid JSON', raw);
      return;
    }

    // 1) Grab our callSid & customParameters on `start`
    if (msg.event === 'start') {
      const p = msg.start.customParameters;
      callSid     = msg.start.callSid;
      agentId     = p.agent_id;
      voiceId     = p.voice_id;
      contactName = p.contact_name;
      address     = p.address;
      console.log('[WS:start]', { callSid, agentId, voiceId, contactName, address });

      // 2) Open Deepgram live‐transcription
      dgSocket = dgClient.transcription.live({
        encoding:    'mulaw',
        sample_rate: 8000,
        punctuate:   true,
        language:    'en-US'
      });
      dgSocket.open();
      dgSocket.addListener('transcriptReceived', dg => {
        if (!dg.is_final) return;
        const text = dg.channel.alternatives[0].transcript.trim();
        console.log('[DG final]', text);
        handleAiReply(text, { callSid, voiceId, contactName, address }, ws);
      });
    }

    // 3) Stream the inbound audio chunks into Deepgram
    else if (msg.event === 'media') {
      const buff = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(buff);
      }
    }

    // 4) On stop, finish Deepgram
    else if (msg.event === 'stop') {
      console.log('[WS] stream stopped');
      dgSocket?.finish();
    }
  });

  ws.on('close', () => {
    console.log('[WS] client closed');
    dgSocket?.finish();
  });
});

// ————————————————————————————————————————————————————————————————
//  AI → ElevenLabs TTS → TwiML Update (Calls.update)
// ————————————————————————————————————————————————————————————————
async function handleAiReply(userText, ctx, ws) {
  try {
    const { callSid, voiceId, contactName, address } = ctx;
    console.log('[AI] user said:', userText);

    // 1) Get AI response
    const sys = `
      You are a friendly appointment reminder assistant.
      Contact name: ${contactName}, address: ${address}.
      Wait for the user to say "hello", then reply exactly:
      "Hi ${contactName}, just confirming your appointment at ${address}."
    `;
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system',  content: sys },
        { role: 'user',    content: userText }
      ]
    });
    const reply = aiRes.choices[0].message.content.trim();
    console.log('[AI] reply:', reply);

    // 2) Generate a μ-law MP3 file from ElevenLabs
    //    (we’ll fetch it all at once then host it on-the-fly)
    const ttsResp = await eleven.textToSpeech({
      voice: voiceId,
      input: reply,
      format: 'audio/mulaw;rate=8000'
    });
    const audioData = await ttsResp.arrayBuffer();

    // 3) Expose it via a quick endpoint—store in memory
    const audioPath = `/tts/${callSid}.raw`;
    audioStore.set(callSid, Buffer.from(audioData));

    // 4) Build new TwiML: restart inbound stream + play our raw μ-law
    const tw = new VoiceResponse();
    tw.start().stream({
      url: `wss://${process.env.HOSTNAME || ws._socket.remoteAddress}/media`,
      track: 'inbound_track'
    });
    tw.play({}, `https://${process.env.HOSTNAME}/tts/${callSid}.raw`);
    tw.pause({ length: 600 });

    console.log('[TwimlUpdate]\n', tw.toString());

    // 5) Push it to Twilio via Calls.update
    await twilioClient.calls(callSid).update({ twiml: tw.toString() });
    console.log('[Twilio] updated call with new TwiML');
  } catch (err) {
    console.error('[handleAiReply] ERROR', err);
  }
}

// ————————————————————————————————————————————————————————————————
//  Simple in-memory audio store + serving
// ————————————————————————————————————————————————————————————————
const audioStore = new Map();
app.get('/tts/:callSid.raw', (req, res) => {
  const buf = audioStore.get(req.params.callSid);
  if (!buf) return res.sendStatus(404);
  res.set('Content-Type', 'audio/basic');  // μ-law raw
  res.send(buf);
});
