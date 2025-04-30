// server.js
require('dotenv').config();

const express               = require('express');
const http                  = require('http');
const { WebSocketServer }   = require('ws');
const cors                  = require('cors');
const bodyParser            = require('body-parser');
const axios                 = require('axios');
const { VoiceResponse }     = require('twilio').twiml;
const { Deepgram, LiveTranscriptionEvents } = require('@deepgram/sdk');
const OpenAI                = require('openai');

const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  PORT = 10000,
} = process.env;

// ————————————————————————————————————————————————————————————————
//  Sanity checks
// ————————————————————————————————————————————————————————————————
for (let key of ['DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ————————————————————————————————————————————————————————————————
//  SDK clients
// ————————————————————————————————————————————————————————————————
const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

// ————————————————————————————————————————————————————————————————
//  Express + TwiML endpoint
// ————————————————————————————————————————————————————————————————
const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));

// Accept both GET and POST from Twilio/N8N
app.all('/twiml', (req, res) => {
  const params = { ...req.query, ...req.body };
  const { agent_id, voice_id, contact_name, address } = params;
  console.log('[TwiML] Received params:', params);

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing one of agent_id, voice_id, contact_name, address');
    return res.status(400).send('Missing required fields');
  }

  const wsUrl = `wss://${req.headers.host}/media`;
  const twiml = new VoiceResponse();

  // 1) Open bi‐directional stream (both_tracks)
  const conn = twiml.connect();
  const stream = conn.stream({ url: wsUrl, track: 'both_tracks' });

  // inject our params so WS sees them
  stream.parameter({ name: 'agent_id',     value: agent_id     });
  stream.parameter({ name: 'voice_id',     value: voice_id     });
  stream.parameter({ name: 'contact_name', value: contact_name });
  stream.parameter({ name: 'address',      value: address      });

  // 2) Say the initial line
  twiml.say({}, `Hi ${contact_name}, just confirming your appointment at ${address}.`);

  // 3) Pause so the call stays open for up to 10min
  twiml.pause({ length: 600 });

  const xml = twiml.toString();
  console.log('[TwiML] →\n', xml);
  res.type('text/xml').send(xml);
});

// ————————————————————————————————————————————————————————————————
//  HTTP + WebSocket upgrade
// ————————————————————————————————————————————————————————————————
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    console.log('[Upgrade] to /media');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ————————————————————————————————————————————————————————————————
//  Media‐stream handler
// ————————————————————————————————————————————————————————————————
wss.on('connection', (ws, req) => {
  console.log('🔗 [WS] Connected:', req.url);

  // pull our custom parameters out of the URL
  const params = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId     = params.get('agent_id');
  const voiceId     = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address     = params.get('address');
  console.log('[WS] Params:', { agentId, voiceId, contactName, address });

  let dgSocket;
  let transcriptSoFar = '';

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] Non‐JSON message:', raw);
      return;
    }

    switch (msg.event) {
      case 'connected':
        console.log('📡 [WS] connected');
        break;

      case 'start':
        console.log('📡 [WS] start:', msg.start);

        // — 1) Send an initial greeting via ElevenLabs
        const greeting = `Hi ${contactName}, just confirming your appointment at ${address}.`;
        console.log('📝 [TTS] greeting:', greeting);
        try {
          const resp = await axios({
            method: 'post',
            url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
            headers: {
              'xi-api-key': ELEVENLABS_API_KEY,
              'Content-Type': 'application/json',
              'Accept': 'audio/mulaw'
            },
            data: {
              text: greeting,
              model_id: 'eleven_monolingual_v1',
              voice_settings: {
                stability: 0.4,
                similarity_boost: 0.75
              }
            },
            responseType: 'stream'
          });

          resp.data.on('data', chunk => {
            ws.send(JSON.stringify({
              event: 'media',
              media: {
                track:   'outbound',
                payload: chunk.toString('base64')
              }
            }));
          });
          resp.data.on('end', () => console.log('✅ [TTS] greeting done'));
        } catch (err) {
          console.error('💥 [TTS] greeting error:', err.message);
        }

        // — 2) Kick off Deepgram live transcription
        dgSocket = deepgram.transcription.live({
          encoding:    'mulaw',
          sample_rate: 8000,
          punctuate:   true,
          language:    'en-US'
        });
        dgSocket.addListener(LiveTranscriptionEvents.Open,    () => console.log('👂 [DG] open'));
        dgSocket.addListener(LiveTranscriptionEvents.Error,   e  => console.error('👂 [DG] error', e));
        dgSocket.addListener(LiveTranscriptionEvents.Close,   ()  => console.log('👂 [DG] closed'));
        dgSocket.addListener(LiveTranscriptionEvents.TranscriptReceived, async dg => {
          const text = dg.channel.alternatives[0].transcript.trim();
          console.log(`👂 [DG] ${dg.is_final? 'final':'partial'}:`, text);
          transcriptSoFar += text + ' ';
          if (dg.is_final) {
            // — 3) Send full turn to OpenAI
            console.log('🤖 [AI] prompt:', transcriptSoFar);
            const aiRes = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role:'user', content: transcriptSoFar }]
            });
            const reply = aiRes.choices[0].message.content.trim();
            console.log('🤖 [AI] reply:', reply);

            // — 4) TTS that reply
            try {
              const resp2 = await axios({
                method: 'post',
                url:    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
                headers: {
                  'xi-api-key': ELEVENLABS_API_KEY,
                  'Content-Type': 'application/json',
                  'Accept': 'audio/mulaw'
                },
                data: {
                  text: reply,
                  model_id: 'eleven_monolingual_v1',
                  voice_settings: { stability: 0.4, similarity_boost: 0.75 }
                },
                responseType: 'stream'
              });
              resp2.data.on('data', chunk => {
                ws.send(JSON.stringify({
                  event: 'media',
                  media: {
                    track:   'outbound',
                    payload: chunk.toString('base64')
                  }
                }));
              });
              resp2.data.on('end', () => console.log('✅ [TTS] reply done'));
            } catch (err) {
              console.error('💥 [TTS] reply error', err.message);
            }

            transcriptSoFar = '';
          }
        });
        break;

      case 'media':
        // feed inbound μ-law chunks into Deepgram
        if (dgSocket && msg.media && msg.media.payload) {
          const bin = Buffer.from(msg.media.payload, 'base64');
          dgSocket.send(bin);
        }
        break;

      case 'stop':
        console.log('🛑 [WS] stop');
        dgSocket?.finish();
        ws.close();
        break;

      default:
        console.log('[WS] unknown event:', msg.event);
    }
  });

  ws.on('close', () => console.log('🛑 [WS] closed'));
  ws.on('error', e => console.error('💥 [WS] error', e));
});

// ————————————————————————————————————————————————————————————————
//  Start listening
// ————————————————————————————————————————————————————————————————
server.listen(PORT, () => {
  console.log(`✅ AI Call Server listening on port ${PORT}`);
});
