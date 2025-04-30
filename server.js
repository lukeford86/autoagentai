// server.js
require('dotenv').config();
const express           = require('express');
const http              = require('http');
const { WebSocketServer } = require('ws');
const cors              = require('cors');
const bodyParser        = require('body-parser');
const { VoiceResponse } = require('twilio').twiml;
const { Deepgram, LiveTranscriptionEvents } = require('@deepgram/sdk');
const ElevenLabs        = require('elevenlabs-node');
const OpenAI            = require('openai');

const {
  ELEVENLABS_API_KEY,
  DEEPGRAM_API_KEY,
  OPENROUTER_API_KEY,
} = process.env;

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });
const port   = process.env.PORT || 10000;

//–– Middlewares ––//
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));

//–– Health check ––//
app.get('/', (_req, res) => {
  res.send('✅ AI Call Server is live');
});

//–– TwiML endpoint ––//
// This will instruct Twilio to open a WebSocket to /media
app.post('/twiml', (req, res) => {
  const params = Object.assign({}, req.query, req.body);
  const { agent_id, voice_id, contact_name, address } = params;
  console.log('[TwiML] Received params:', params);
  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required fields');
    return res.status(400).send('Missing required fields');
  }

  const wsUrl = `wss://${req.headers.host}/media`;
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const stream  = connect.stream({ url: wsUrl, track: 'both_tracks' });

  // inject our custom query‐string params
  stream.parameter({ name: 'agent_id',     value: agent_id     });
  stream.parameter({ name: 'voice_id',     value: voice_id     });
  stream.parameter({ name: 'contact_name', value: contact_name });
  stream.parameter({ name: 'address',      value: address      });

  const xml = twiml.toString();
  console.log('[TwiML] Sending XML:', xml);
  res.type('text/xml').send(xml);
});

//–– Handle WebSocket upgrade ––//
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

//–– SDK clients ––//
const deepgram = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabs({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

//–– WebSocket handler ––//
wss.on('connection', (ws, req) => {
  console.log('🔗 [WS] Connection established');

  // pull our custom parameters out of the URL
  const params = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId     = params.get('agent_id');
  const voiceId     = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address     = params.get('address');
  console.log('[WS] Custom parameters:', { agentId, voiceId, contactName, address });

  let dgSocket;
  let transcriptBuffer = '';

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] Received non-JSON message');
      return;
    }

    switch (msg.event) {
      case 'connected':
        console.log('📡 [WS] connected event');
        break;

      case 'start':
        console.log('📡 [WS] start event:', msg.start);

        // 1) send an initial greeting via ElevenLabs
        const greeting = `Hi ${contactName}, just confirming your appointment at ${address}.`;
        console.log('📝 [TTS] Sending greeting:', greeting);
        try {
          const ttsStream = await eleven.textToSpeechStream({
            voiceId,
            textInput: greeting,
            modelId: 'eleven_monolingual_v1',
            responseType: 'stream',
            stability: 0.4,
            similarityBoost: 0.75,
          });
          ttsStream.on('data', chunk => {
            ws.send(JSON.stringify({
              event: 'media',
              media: {
                payload: chunk.toString('base64'),
                track: 'outbound'
              }
            }));
          });
          ttsStream.on('end', () => console.log('✅ [TTS] Greeting ended'));
        } catch (err) {
          console.error('💥 [TTS] error streaming greeting:', err);
        }

        // 2) spin up Deepgram live transcription (mulaw@8kHz)
        dgSocket = deepgram.transcription.live({
          encoding: 'mulaw',
          sampleRate: 8000,
          model: 'general'
        });
        dgSocket.on(LiveTranscriptionEvents.Open,   () => console.log('👂 [DG] Socket open'));
        dgSocket.on(LiveTranscriptionEvents.Error,  err => console.error('👂 [DG] Error:', err));
        dgSocket.on(LiveTranscriptionEvents.Close,  ()  => console.log('👂 [DG] Closed'));
        dgSocket.on(LiveTranscriptionEvents.TranscriptReceived, async transcript => {
          const text = transcript.alternatives[0].transcript;
          console.log('👂 [DG] Transcript:', text, 'final?', transcript.isFinal);
          transcriptBuffer += text + ' ';
          if (transcript.isFinal) {
            // 3) send the full turn to OpenAI
            console.log('🤖 [AI] Prompt:', transcriptBuffer);
            const aiResp = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: [{ role: 'user', content: transcriptBuffer }]
            });
            const reply = aiResp.choices[0].message.content;
            console.log('🤖 [AI] Reply:', reply);

            // 4) speak the reply via ElevenLabs
            try {
              const replyStream = await eleven.textToSpeechStream({
                voiceId,
                textInput: reply,
                modelId: 'eleven_monolingual_v1',
                responseType: 'stream'
              });
              replyStream.on('data', chunk => {
                ws.send(JSON.stringify({
                  event: 'media',
                  media: {
                    payload: chunk.toString('base64'),
                    track: 'outbound'
                  }
                }));
              });
              replyStream.on('end', () => console.log('✅ [TTS] Reply ended'));
            } catch (err) {
              console.error('💥 [TTS] Reply error:', err);
            }

            transcriptBuffer = '';
          }
        });
        break;

      case 'media':
        // feed inbound audio into Deepgram
        if (dgSocket) {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          dgSocket.send(pcm);
        }
        break;

      case 'stop':
        console.log('🛑 [WS] stop event');
        if (dgSocket) dgSocket.requestClose();
        ws.close();
        break;

      default:
        console.log('[WS] Unhandled event:', msg.event);
    }
  });

  ws.on('close', () => console.log('🛑 [WS] Connection closed'));
  ws.on('error', err => console.error('💥 [WS] Error:', err));
});

server.listen(port, () => {
  console.log(`✅ AI Call Server running on port ${port}`);
});
