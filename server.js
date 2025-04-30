// server.js
require('dotenv').config();

const express         = require('express');
const bodyParser      = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;
const { Deepgram }    = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI          = require('openai');
const WebSocket       = require('ws');

const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  PORT = 10000,
} = process.env;

// sanity check
for (let key of ['DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing env var: ${key}`);
    process.exit(1);
  }
}

const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 1) TwiML endpoint
app.post('/twiml', (req, res) => {
  const params = {
    agent_id:     req.query.agent_id     || req.body.agent_id,
    voice_id:     req.query.voice_id     || req.body.voice_id,
    contact_name: req.query.contact_name || req.body.contact_name,
    address:      req.query.address      || req.body.address,
  };
  console.log('[TwiML] Received params:', params);

  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'alice', language: 'en-US' },
    `Hi ${params.contact_name}, just confirming your appointment at ${params.address}.`
  );
  const connect = twiml.connect();
  connect.stream({
    url:       `wss://${req.headers.host}/media`,
    track:     'both_tracks',
    parameters: params,
  });

  res.type('text/xml').send(twiml.toString());
});

// 2) Start HTTP + WS servers
const server = app.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
  console.log('==> Your service is live 🎉');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// 3) Handle Twilio Media Stream connections
wss.on('connection', (ws, req) => {
  console.log('[WS] Twilio stream connected');
  let dgSocket;
  let params;

  ws.on('message', async raw => {
    const msg = JSON.parse(raw);

    if (msg.event === 'start') {
      // pull customParameters
      params = msg.start.customParameters;
      console.log('[WS] start → customParameters:', params);

      // set up Deepgram live transcription
      dgSocket = deepgram.transcription.live({
        punctuate:    true,
        encoding:     'mulaw',
        sample_rate:  8000,
        language:     'en-US',
      });

      // IMPORTANT: actually open the socket
      dgSocket.open();

      dgSocket.addListener('open',  () => console.log('[Deepgram] open'));
      dgSocket.addListener('close', () => console.log('[Deepgram] closed'));
      dgSocket.addListener('error', e => console.error('[Deepgram] error', e));
      dgSocket.addListener('transcriptReceived', async dg => {
        const text = dg.channel.alternatives[0].transcript;
        console.log('[Deepgram] transcript:', text);
        if (dg.is_final) {
          await handleAiTts(text, params, ws);
        }
      });
    }
    else if (msg.event === 'media') {
      // only send into Deepgram if socket is open
      const payload = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        try {
          dgSocket.send(payload);
        } catch (err) {
          console.warn('[Deepgram] send skipped (socket not open)');
        }
      }
    }
    else if (msg.event === 'stop') {
      console.log('[WS] stop');
      if (dgSocket) dgSocket.finish();
    }
  });

  ws.on('close', () => {
    console.log('[WS] disconnected');
    if (dgSocket) dgSocket.finish();
  });
});

// 4) on final transcript → call AI, then ElevenLabs, then back to Twilio
async function handleAiTts(userText, params, ws) {
  try {
    console.log('[AI] generating reply…');
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user',   content: userText },
      ],
    });
    const reply = aiRes.choices[0].message.content.trim();
    console.log('[AI] reply:', reply);

    console.log('[TTS] requesting ElevenLabs stream…');
    const stream = await eleven.generate({
      voice:    params.voice_id,
      text:     reply,
      model_id: 'eleven_multilingual_v2',
      stream:   true,
    });

    for await (const chunk of stream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track:   'outbound_track',
          payload: chunk.toString('base64'),
        }
      }));
    }
  } catch (err) {
    console.error('[AI/TTS] error:', err);
  }
}
