// server.js
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;
const { Deepgram } = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const { Configuration, OpenAIApi } = require('openai');
const WebSocket = require('ws');

const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  PORT = 10000,
} = process.env;

if (!DEEPGRAM_API_KEY || !ELEVENLABS_API_KEY || !OPENROUTER_API_KEY) {
  console.error('🚨 Missing one of DEEPGRAM_API_KEY, ELEVENLABS_API_KEY or OPENROUTER_API_KEY');
  process.exit(1);
}

// Initialize SDK clients
const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const eleven  = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai  = new OpenAIApi(new Configuration({ apiKey: OPENROUTER_API_KEY }));

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 1) TwiML endpoint for incoming calls
app.post('/twiml', (req, res) => {
  // Pull in your custom parameters (sent via query or form-post)
  const params = {
    agent_id:     req.query.agent_id     || req.body.agent_id,
    voice_id:     req.query.voice_id     || req.body.voice_id,
    contact_name: req.query.contact_name || req.body.contact_name,
    address:      req.query.address      || req.body.address,
  };

  console.log('[TwiML] Received params:', params);

  // Build the TwiML to say a prompt then start streaming both directions
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'alice', language: 'en-US' },
    `Hi ${params.contact_name}, just confirming your appointment at ${params.address}.`
  );
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/media`,
    track: 'both_tracks',               // inbound + outbound
    parameters: params,
  });

  res.type('text/xml').send(twiml.toString());
});

// 2) Spin up the HTTP + WS servers
const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log('==> Your service is live 🎉');
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// 3) Handle each Twilio Media Stream connection
wss.on('connection', (ws, req) => {
  console.log('[WS] Twilio stream connected');
  let dgSocket;
  let params;

  ws.on('message', async raw => {
    const msg = JSON.parse(raw);

    if (msg.event === 'start') {
      // Grab the custom parameters out of the start event
      params = msg.start.customParameters;
      console.log('[WS] start → customParameters:', params);

      // Open a Deepgram live transcription socket
      dgSocket = deepgram.transcription.live({
        punctuate:    true,
        encoding:     'mulaw',
        sample_rate:  8000,
        language:     'en-US',
      });

      dgSocket.addListener('open',   () => console.log('[Deepgram] open'));
      dgSocket.addListener('close',  () => console.log('[Deepgram] closed'));
      dgSocket.addListener('error',  e => console.error('[Deepgram] error', e));
      dgSocket.addListener('transcriptReceived', async dg => {
        const text = dg.channel.alternatives[0].transcript;
        console.log('[Deepgram] transcript:', text);
        if (dg.is_final) await handleAiTts(text, params, ws);
      });
    }

    else if (msg.event === 'media') {
      // Forward each media chunk into Deepgram
      const buffer = Buffer.from(msg.media.payload, 'base64');
      dgSocket.send(buffer);
    }

    else if (msg.event === 'stop') {
      console.log('[WS] stop');
      dgSocket.finish();
    }
  });

  ws.on('close', () => console.log('[WS] connection closed'));
});

// 4) On final transcript, call AI & TTS, then stream it back
async function handleAiTts(text, params, ws) {
  try {
    console.log('[AI] thinking...');
    const aiRes = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: text },
      ],
    });
    const reply = aiRes.data.choices[0].message.content;
    console.log('[AI] reply:', reply);

    // Generate a streaming TTS response
    const audioStream = await eleven.generate({
      voice:     params.voice_id,
      text:      reply,
      model_id:  'eleven_multilingual_v2',
      stream:    true,
    });

    // Pipe each chunk back to Twilio
    for await (const chunk of audioStream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track:   'outbound_track',
          payload: chunk.toString('base64'),
        }
      }));
    }
  } catch (err) {
    console.error('[AI/TTS] error', err);
  }
}
