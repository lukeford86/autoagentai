// server.js
require('dotenv').config();

const express            = require('express');
const bodyParser         = require('body-parser');
const WebSocket          = require('ws');
const { VoiceResponse }  = require('twilio').twiml;
const { Deepgram }       = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI             = require('openai');

// ————————————————————————————————————————————————————————————————
//  Environment & sanity checks
// ————————————————————————————————————————————————————————————————
const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 10000,
} = process.env;

for (let key of ['DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Twilio credentials are only needed for Calls.update
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  const Twilio = require('twilio');
  twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing; call updates will be disabled');
}

// ————————————————————————————————————————————————————————————————
//  SDK clients
// ————————————————————————————————————————————————————————————————
const dgClient = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

// ————————————————————————————————————————————————————————————————
//  Express + TwiML endpoint
// ————————————————————————————————————————————————————————————————
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] params:', { agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();
  // 1) Fork inbound audio to our WS
  twiml.start().stream({
    url:   `wss://${req.headers.host}/media`,
    track: 'inbound_track'
  });
  // 2) Play the initial reminder
  twiml.say(
    { voice: 'Polly.Joanna' },
    `Hi ${contact_name}, just confirming your appointment at ${address}.`
  );
  // 3) Keep the call open for up to 10 minutes
  twiml.pause({ length: 600 });

  console.log('[TwiML XML]\n' + twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

// ————————————————————————————————————————————————————————————————
//  Server + WebSocket upgrade
// ————————————————————————————————————————————————————————————————
const server = app.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT} — service live`);
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('[Upgrade] request for', req.url);
  if (req.url.startsWith('/media')) {
    console.log('[Upgrade] upgrading to WS');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    console.log('[Upgrade] not /media, destroying socket');
    socket.destroy();
  }
});

// ————————————————————————————————————————————————————————————————
//  WebSocket handler: Deepgram STT + AI/TTS loop
// ————————————————————————————————————————————————————————————————
wss.on('connection', (ws, req) => {
  console.log('[WS] Connection established:', req.url);

  let dgSocket, callSid;
  let voiceId, contactName, address, agentId;

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] Invalid JSON:', raw);
      return;
    }

    if (msg.event === 'start') {
      // Extract call context
      callSid      = msg.start.callSid;
      ({ agent_id: agentId, voice_id: voiceId, contact_name: contactName, address } = msg.start.customParameters);
      console.log('[WS] start]', { callSid, agentId, voiceId, contactName, address });

      // Begin Deepgram live transcription
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
        console.log('[Deepgram final]', text);
        handleAiReply(text, { callSid, voiceId, contactName, address }, ws);
      });
    }
    else if (msg.event === 'media') {
      // Feed inbound audio to Deepgram
      const buffer = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(buffer);
      }
    }
    else if (msg.event === 'stop') {
      console.log('[WS] stop event');
      dgSocket?.finish();
    }
  });

  ws.on('close', () => {
    console.log('[WS] disconnected');
    dgSocket?.finish();
  });
});

// ————————————————————————————————————————————————————————————————
//  AI → ElevenLabs TTS → (optional) Twilio Calls.update
// ————————————————————————————————————————————————————————————————
async function handleAiReply(userText, ctx, ws) {
  try {
    const { callSid, voiceId, contactName, address } = ctx;
    console.log('[AI] user said:', userText);

    // Generate AI reply
    const systemPrompt = `
      You are an appointment reminder assistant.
      Contact: ${contactName}, Address: ${address}.
      Wait until the user says "Hello", then reply exactly:
      "Hi ${contactName}, just confirming your appointment at ${address}."
    `;
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText },
      ]
    });
    const reply = aiRes.choices[0].message.content.trim();
    console.log('[AI] reply:', reply);

    // Generate μ-law audio via ElevenLabs
    const ttsStream = await eleven.generate({
      voice:    voiceId,
      text:     reply,
      model_id: 'eleven_multilingual_v2',
      stream:   true
    });

    // Stream TTS back on the WS outbound track
    for await (const chunk of ttsStream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track:   'outbound_track',
          payload: chunk.toString('base64'),
        }
      }));
    }
    console.log('[TTS] done streaming');

    // Optionally update the call's TwiML if Twilio client is configured
    if (twilioClient) {
      console.log('[Twilio] updating call TwiML for next turn');
      const tw = new VoiceResponse();
      tw.start().stream({ url: `wss://${process.env.HOSTNAME||ws._socket.remoteAddress}/media`, track: 'inbound_track' });
      tw.say({ voice: 'Polly.Joanna' }, reply);
      tw.pause({ length: 600 });
      await twilioClient.calls(callSid).update({ twiml: tw.toString() });
      console.log('[Twilio] call TwiML updated');
    }
  } catch (err) {
    console.error('[handleAiReply] error:', err);
  }
}
