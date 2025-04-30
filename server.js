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

// Sanity check env
for (let key of ['DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing env var: ${key}`);
    process.exit(1);
  }
}

// Init SDK clients
const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// 1) TwiML endpoint — returns <Connect><Stream>
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
    track:      'both_tracks',
    parameters: params,
  });

  console.log('[TwiML XML]\n' + twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

// 2) HTTP & WebSocket upgrade
const server = app.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT}`);
  console.log('==> Your service is live 🎉');
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  console.log('[Upgrade] incoming request for:', req.url);
  if (req.url.startsWith('/media')) {
    console.log('[Upgrade] matched /media, upgrading to WS');
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    console.log('[Upgrade] not /media, destroying socket');
    socket.destroy();
  }
});

// 3) Handle Twilio MediaStream WS
wss.on('connection', (ws, req) => {
  console.log('[WS] Connection established, URL:', req.url);

  let dgSocket;
  let params;

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.error('[WS] Invalid JSON:', raw);
      return;
    }
    console.log('[WS] raw event:', msg.event, msg);

    if (msg.event === 'connected') {
      console.log('[WS] Twilio call connected');
    }

    else if (msg.event === 'start') {
      params = msg.start.customParameters;
      console.log('[WS] Media start, parameters:', params);

      // Start Deepgram live transcription
      dgSocket = deepgram.transcription.live({
        encoding:    'mulaw',
        sample_rate: 8000,
        punctuate:   true,
        language:    'en-US',
      });
      dgSocket.open();

      dgSocket.addListener('open',    () => console.log('[Deepgram] socket open'));
      dgSocket.addListener('close',   () => console.log('[Deepgram] socket closed'));
      dgSocket.addListener('error',   e => console.error('[Deepgram] error', e));
      dgSocket.addListener('transcriptReceived', async dg => {
        const text = dg.channel.alternatives[0].transcript.trim();
        console.log('[Deepgram]', dg.is_final ? 'final:' : 'interim:', text);
        if (dg.is_final && text) {
          await handleAiTts(text, params, ws);
        }
      });
    }

    else if (msg.event === 'media') {
      // inbound audio chunk → Deepgram
      const buffer = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        try {
          dgSocket.send(buffer);
        } catch {
          console.warn('[Deepgram] send skipped, socket not open');
        }
      }
    }

    else if (msg.event === 'stop') {
      console.log('[WS] MediaStream stop');
      dgSocket?.finish();
    }
  });

  ws.on('close', () => {
    console.log('[WS] client disconnected');
    dgSocket?.finish();
  });
});

// 4) AI + TTS → Twilio
async function handleAiTts(userText, params, ws) {
  try {
    console.log('[AI] Generating reply for:', userText);
    const systemPrompt =
      `You are an appointment reminder assistant. Contact: ${params.contact_name}, Address: ${params.address}.`
      + ` The client will say "Hello" to start. After they say hello, reply exactly:`
      + ` "Hi ${params.contact_name}, just confirming your appointment at ${params.address}."`;

    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText },
      ],
    });
    const reply = aiRes.choices[0].message.content.trim();
    console.log('[AI] Reply:', reply);

    console.log('[TTS] Streaming ElevenLabs audio…');
    const ttsStream = await eleven.generate({
      voice:    params.voice_id,
      text:     reply,
      model_id: 'eleven_multilingual_v2',
      stream:   true,
    });

    for await (const chunk of ttsStream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track:   'outbound_track',
          payload: chunk.toString('base64'),
        }
      }));
    }
    console.log('[TTS] Finished streaming');
  } catch (err) {
    console.error('[AI/TTS] error:', err);
  }
}
