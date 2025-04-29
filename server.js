// server.js
require('dotenv').config();

const express       = require('express');
const bodyParser    = require('body-parser');
const http          = require('http');
const WebSocket     = require('ws');
const { Deepgram }  = require('@deepgram/sdk');
const ElevenLabsAPI = require('elevenlabs');
const { OpenAI }    = require('openai');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

//
// —– Configuration
//
const DEEPGRAM_API_KEY   = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const PORT = process.env.PORT || 10000;

const deepgram    = new Deepgram(DEEPGRAM_API_KEY);
const elevenlabs  = new ElevenLabsAPI({ apiKey: ELEVENLABS_API_KEY });
const openai      = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1'
});

//
// —– Express + TwiML endpoint
//
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/', (_, res) => res.send('OK'));

app.post('/twiml', (req, res) => {
  // Twilio will GET/POST here with your four query params
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  // Build TwiML <Connect><Stream>
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  const url = `${req.protocol === 'https' ? 'wss' : 'ws'}://${req.get('host')}/media`
              + `?agent_id=${encodeURIComponent(agent_id)}`
              + `&voice_id=${encodeURIComponent(voice_id)}`
              + `&contact_name=${encodeURIComponent(contact_name)}`
              + `&address=${encodeURIComponent(address)}`;

  connect.stream({ url })
    .parameter({ name: 'agent_id',     value: agent_id     })
    .parameter({ name: 'voice_id',     value: voice_id     })
    .parameter({ name: 'contact_name', value: contact_name })
    .parameter({ name: 'address',      value: address      });

  res.type('text/xml').send(twiml.toString());
});

//
// —– HTTP + WebSocket server
//
const server = http.createServer(app);
const wss    = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  // parse out our custom params again from the WebSocket URL
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const agent_id     = params.get('agent_id');
  const voice_id     = params.get('voice_id');
  const contact_name = params.get('contact_name');
  const address      = params.get('address');

  console.log('[WS] New Twilio stream, awaiting <Start>…');

  let dgSocket, aiSocket;
  let transcriptBuffer = '';

  ws.on('message', async raw => {
    const msg = JSON.parse(raw);

    // —– CALL STARTED
    if (msg.event === 'start') {
      console.log('[WS] <Start> customParameters:', msg.start.customParameters);

      // 1) Deepgram live transcription socket
      dgSocket = deepgram.transcription.live({
        punctuate:      true,
        interim_results:false,
        encoding:       msg.start.mediaFormat.encoding,
        sample_rate:    msg.start.mediaFormat.sampleRate
      });

      dgSocket.addListener('transcriptReceived', data => {
        const text = data.channel.alternatives[0].transcript;
        console.log('[Deepgram]', text);
        // forward to AI once we have a non-empty transcript
        if (text.trim() && aiSocket && aiSocket.readyState === WebSocket.OPEN) {
          aiSocket.send(JSON.stringify({ role: 'user', content: text }));
        }
      });

      // 2) OpenRouter chat WebSocket
      aiSocket = new WebSocket('wss://openrouter.ai/v1/chat', {
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
      });

      aiSocket.on('open', () => {
        console.log('[AI WS] connected');
        // prime the conversation if you like:
        aiSocket.send(JSON.stringify({
          role: 'system',
          content: `You are an appointment reminder agent. Contact: ${contact_name}, Address: ${address}.`
        }));
      });

      aiSocket.on('message', async chunk => {
        const payload = JSON.parse(chunk);
        // accumulate content deltas
        if (payload.choices?.[0]?.delta?.content) {
          transcriptBuffer += payload.choices[0].delta.content;
        }
        // on end of response
        if (payload.choices?.[0]?.finish_reason) {
          console.log('[AI]', transcriptBuffer);

          // 3) ElevenLabs TTS
          const audioBuffer = await elevenlabs.textToSpeech({
            voice: voice_id,
            model: 'eleven_monolingual_v1',
            input: transcriptBuffer
          });

          // send back into Twilio media stream
          ws.send(JSON.stringify({
            event: 'media',
            media: { payload: audioBuffer.toString('base64') }
          }));

          transcriptBuffer = '';
        }
      });

      aiSocket.on('close', () => console.log('[AI WS] closed'));

      // finally hook Twilio media → Deepgram
      dgSocket.addListener('open', () => console.log('[Deepgram WS] open'));
      dgSocket.addListener('close', ()=> console.log('[Deepgram WS] closed'));
    }

    // —– MEDIA CHUNK
    else if (msg.event === 'media') {
      const audio = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
        dgSocket.send(audio);
      }
    }

    // —– CALL ENDED
    else if (msg.event === 'stop') {
      console.log('[WS] <Stop>');
      if (dgSocket)   dgSocket.finish();
      if (aiSocket)   aiSocket.close();
      ws.close();
    }
  });

  ws.on('close', () => console.log('[WS] Twilio disconnected'));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
