// server.js
require('dotenv').config();

const express           = require('express');
const bodyParser        = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;
const { Deepgram }      = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI            = require('openai');
const WebSocket         = require('ws');

const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  PORT = 10000,
} = process.env;

// ⓵ Sanity-check
for (let key of ['DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing env var: ${key}`);
    process.exit(1);
  }
}

// ⓶ Init SDKs
const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 1) TwiML webhook — now uses stream.parameter() for nested <Parameter> tags
app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received params:', { agent_id, voice_id, contact_name, address });

  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream = connect.stream({
    url:   `wss://${req.headers.host}/media`,
    track: 'both_tracks',
  });

  // Properly inject four <Parameter> child elements
  stream.parameter({ name: 'agent_id',    value: agent_id });
  stream.parameter({ name: 'voice_id',    value: voice_id });
  stream.parameter({ name: 'contact_name',value: contact_name });
  stream.parameter({ name: 'address',     value: address });

  console.log('[TwiML XML]\n' + twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

// 2) Start HTTP + WS server
const server = app.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
  console.log('==> Your service is live 🎉');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('[Upgrade] incoming request for:', req.url);
  if (req.url.startsWith('/media')) {
    console.log('[Upgrade] matched /media, upgrading…');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    console.log('[Upgrade] rejecting non-media path');
    socket.destroy();
  }
});

// 3) Handle Twilio MediaStream
wss.on('connection', (ws, req) => {
  console.log('[WS] Connection established, URL:', req.url);

  let dgSocket, params;

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] invalid JSON:', raw);
      return;
    }
    console.log('[WS] raw event:', msg.event);

    if (msg.event === 'start') {
      params = msg.start.customParameters;
      console.log('[WS] start →', params);

      dgSocket = deepgram.transcription.live({
        encoding:    'mulaw',
        sample_rate: 8000,
        punctuate:   true,
        language:    'en-US'
      });
      dgSocket.open();
      dgSocket.addListener('transcriptReceived', async dg => {
        const text = dg.channel.alternatives[0].transcript.trim();
        console.log('[Deepgram]', dg.is_final ? 'final:' : 'interim:', text);
        if (dg.is_final && text) {
          await handleAiTts(text, params, ws);
        }
      });
    }
    else if (msg.event === 'media') {
      const buffer = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket?.readyState === WebSocket.OPEN) {
        try { dgSocket.send(buffer) }
        catch { console.warn('[Deepgram] skipped send, socket not open') }
      }
    }
    else if (msg.event === 'stop') {
      console.log('[WS] stop');
      dgSocket?.finish();
    }
  });

  ws.on('close', () => {
    console.log('[WS] disconnected');
    dgSocket?.finish();
  });
});

// 4) AI → ElevenLabs TTS → back on the outbound track
async function handleAiTts(userText, params, ws) {
  try {
    console.log('[AI] generating reply for:', userText);
    const systemPrompt =
      `You are an appointment reminder assistant. Contact: ${params.contact_name},`
      + ` Address: ${params.address}. Wait until they say "Hello", then reply:`
      + ` "Hi ${params.contact_name}, just confirming your appointment at ${params.address}."`;

    const ai = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText },
      ]
    });
    const reply = ai.choices[0].message.content.trim();
    console.log('[AI] reply:', reply);

    console.log('[TTS] streaming ElevenLabs…');
    const ttsStream = await eleven.generate({
      voice:    params.voice_id,
      text:     reply,
      model_id: 'eleven_multilingual_v2',
      stream:   true
    });

    for await (const chunk of ttsStream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track:   'outbound_track',
          payload: chunk.toString('base64')
        }
      }));
    }
    console.log('[TTS] done streaming');
  } catch (e) {
    console.error('[AI/TTS] error:', e);
  }
}
