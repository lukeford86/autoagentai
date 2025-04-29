// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Deepgram } = require('@deepgram/sdk');
const fetch = require('node-fetch');
const { twiml: { VoiceResponse } } = require('twilio');
const WebSocket = require('ws');

// Pull in your API keys from env
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!DEEPGRAM_API_KEY || !ELEVENLABS_API_KEY || !OPENROUTER_API_KEY) {
  console.warn('⚠️  Missing one or more API keys in your environment.');
}

// Init Deepgram client
const deepgram = new Deepgram(DEEPGRAM_API_KEY);

// Set up Express
const app = express();
// Twilio will POST your query params here
app.use(express.urlencoded({ extended: false }));

// --- TwiML endpoint that kicks off the <Connect><Stream> ---
app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  const vr = new VoiceResponse();
  const connect = vr.connect();
  // Twilio will open a WS to /media on this same host
  const wsUrl = `wss://${req.get('Host')}/media`;
  const stream = connect.stream({ url: wsUrl });

  // Pass your custom parameters through to the media WebSocket
  stream.parameter({ name: 'agent_id',      value: agent_id });
  stream.parameter({ name: 'voice_id',      value: voice_id });
  stream.parameter({ name: 'contact_name',  value: contact_name });
  stream.parameter({ name: 'address',       value: address });

  res.type('text/xml');
  res.send(vr.toString());
});

// --- HTTP + WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

wss.on('connection', ws => {
  console.log('[WS] Twilio stream opened, awaiting start event…');

  let params = {};
  let dgSocket;

  ws.on('message', async raw => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === 'start') {
      // Grab your customParameters here
      params = msg.start.customParameters;
      console.log('[WS] start → customParameters:', params);

      // Wire up Deepgram live transcription
      dgSocket = deepgram.transcription.live(
        {
          encoding:   msg.start.mediaFormat.encoding,
          sampleRate: msg.start.mediaFormat.sampleRate,
          channels:   msg.start.mediaFormat.channels
        },
        { punctuate: true, interim_results: false }
      );

      // Whenever Deepgram returns a final transcript…
      dgSocket.addListener('transcriptReceived', async data => {
        const transcript = data.channel.alternatives[0].transcript;
        console.log('[DG] transcript:', transcript);

        // 1) Generate your AI reply
        const aiReply = await generateAIResponse(transcript, params);
        console.log('[AI] reply:', aiReply);

        // 2) Turn it into speech via ElevenLabs
        const ttsBase64 = await synthesizeSpeech(aiReply, params.voice_id);

        // 3) Send it back to Twilio as outbound media
        ws.send(JSON.stringify({
          event: 'media',
          media: {
            track:   'outbound',
            payload: ttsBase64
          }
        }));
      });
    }

    else if (msg.event === 'media') {
      // feed Twilio payload into Deepgram
      const audioBuffer = Buffer.from(msg.media.payload, 'base64');
      dgSocket.send(audioBuffer);
    }

    else if (msg.event === 'stop') {
      console.log('[WS] stop → closing Deepgram socket');
      dgSocket.finish();
      ws.close();
    }
  });

  ws.on('close', () => console.log('[WS] closed'));
  ws.on('error', e => console.error('[WS] error', e));
});

// --- Helpers ---

async function generateAIResponse(userText, { contact_name, address }) {
  const resp = await fetch('https://api.openrouter.ai/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a friendly appointment confirmation assistant.' },
        { role: 'user',   content: `The customer is ${contact_name} at ${address}. They said: "${userText}"` }
      ]
    })
  });
  const j = await resp.json();
  return j.choices[0].message.content;
}

async function synthesizeSpeech(text, voiceId) {
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key':   ELEVENLABS_API_KEY
      },
      body: JSON.stringify({ text })
    }
  );
  // ElevenLabs returns raw audio (mp3) — base64 it for Twilio
  const buf = await resp.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

// --- Listen ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
