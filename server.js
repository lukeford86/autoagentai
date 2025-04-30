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

// init SDK clients
const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 1) TwiML endpoint — no <Say>, just <Connect><Stream>
app.post('/twiml', (req, res) => {
  const params = {
    agent_id:     req.query.agent_id     || req.body.agent_id,
    voice_id:     req.query.voice_id     || req.body.voice_id,
    contact_name: req.query.contact_name || req.body.contact_name,
    address:      req.query.address      || req.body.address,
  };
  console.log('[TwiML] Received params:', params);

  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url:        `wss://${req.headers.host}/media`,
    // don't specify track → streams inbound by default
    parameters: params
  });

  res.type('text/xml').send(twiml.toString());
});

// 2) Start HTTP + WS server
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

// 3) Handle each Twilio Media Stream
wss.on('connection', (ws, req) => {
  console.log('[WS] Twilio MediaStream connected');
  let dgSocket, params;

  ws.on('message', async raw => {
    const msg = JSON.parse(raw);

    if (msg.event === 'start') {
      params = msg.start.customParameters;
      console.log('[WS] start →', params);

      // set up Deepgram transcription
      dgSocket = deepgram.transcription.live({
        punctuate:     true,
        encoding:      'mulaw',
        sample_rate:   8000,
        language:      'en-US'
      });
      dgSocket.open();

      dgSocket.addListener('open',    () => console.log('[Deepgram] open'));
      dgSocket.addListener('close',   () => console.log('[Deepgram] closed'));
      dgSocket.addListener('error',   e => console.error('[Deepgram] error', e));
      dgSocket.addListener('transcriptReceived', async dg => {
        const text = dg.channel.alternatives[0].transcript;
        console.log('[Deepgram]', dg.is_final ? 'final:' : 'interim:', text);
        // only fire AI/TTS when Deepgram says it's final
        if (dg.is_final && text.trim()) {
          await handleAiTts(text.trim(), params, ws);
        }
      });
    }
    else if (msg.event === 'media') {
      // guard against sending before Deepgram WS is open
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        try {
          const audio = Buffer.from(msg.media.payload, 'base64');
          dgSocket.send(audio);
        } catch {
          console.warn('[Deepgram] skipped send: socket not open');
        }
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

// 4) Once you have a final transcript, run through OpenAI → ElevenLabs → back to Twilio
async function handleAiTts(userText, params, ws) {
  try {
    console.log('[AI] Asking GPT for next line…');
    // prime AI so that its very first reply is your appointment reminder
    const systemPrompt = 
      `You are an appointment reminder bot. Contact: ${params.contact_name}, Address: ${params.address}.`
      + ` Wait silently until they say "Hello". Once they say hello, immediately respond with`
      + ` "Hi ${params.contact_name}, just confirming your appointment at ${params.address}."`
      + ` Then end if no further input.`;

    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText }
      ]
    });
    const reply = aiRes.choices[0].message.content.trim();
    console.log('[AI] reply:', reply);

    console.log('[TTS] Streaming ElevenLabs audio…');
    const ttsStream = await eleven.generate({
      voice:    params.voice_id,
      text:     reply,
      model_id: 'eleven_multilingual_v2',
      stream:   true
    });

    // send each chunk back as an outbound media event
    for await (const chunk of ttsStream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track:   'outbound',             // must be exactly "outbound"
          payload: chunk.toString('base64')
        }
      }));
    }
  } catch (err) {
    console.error('[AI/TTS] error:', err);
  }
}
