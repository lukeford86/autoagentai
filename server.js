// server.js
require('dotenv').config();

const express = require('express');
const { urlencoded } = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Deepgram } = require('@deepgram/sdk');
const { Twilio } = require('twilio');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.use(urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Initialize Deepgram
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);

// 1) TwiML endpoint to kick off a <Connect><Stream>
app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] Received query params:', { agent_id, voice_id, contact_name, address });

  const twiml = new Twilio.twiml.VoiceResponse();
  // Build the WebSocket URL, passing through our custom parameters
  const proto = req.protocol === 'https' ? 'wss' : 'ws';
  const host  = req.get('host');
  const params = new URLSearchParams({ agent_id, voice_id, contact_name, address });
  const wsUrl = `${proto}://${host}/media?${params.toString()}`;

  const connect = twiml.connect();
  connect.stream({ url: wsUrl });
  // brief pause so the stream has time to open
  twiml.pause({ length: 1 });

  res.type('text/xml').send(twiml.toString());
});

// 2) Upgrade HTTP → WebSocket for /media
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// 3) Handle the Twilio media WebSocket
wss.on('connection', (ws, req) => {
  // parse our custom params out of the query string
  const qp = new URLSearchParams(req.url.slice(req.url.indexOf('?')));
  const agent_id     = qp.get('agent_id');
  const voice_id     = qp.get('voice_id');
  const contact_name = qp.get('contact_name');
  const address      = qp.get('address');

  console.log('[WS] Twilio stream opened with params:', { agent_id, voice_id, contact_name, address });

  let dgSocket = null;

  ws.on('message', async (raw) => {
    const msg = JSON.parse(raw);

    switch (msg.event) {
      case 'start':
        // Open Deepgram live‐transcription stream
        dgSocket = deepgram.transcription.live({
          punctuate: true,
          interim_results: false,
          encoding: msg.start.mediaFormat.encoding,
          sample_rate: msg.start.mediaFormat.sampleRate,
          channels: msg.start.mediaFormat.channels
        });
        dgSocket.addListener('transcriptReceived', handleTranscript);
        break;

      case 'media':
        // Feed incoming audio into Deepgram
        if (dgSocket) {
          const audio = Buffer.from(msg.media.payload, 'base64');
          dgSocket.send(audio);
        }
        break;

      case 'stop':
        // End the Deepgram stream
        if (dgSocket) dgSocket.finish();
        break;
    }
  });

  ws.on('close', () => {
    console.log('[WS] Twilio disconnected');
    if (dgSocket) dgSocket.finish();
  });

  // Called whenever Deepgram emits a (final) transcript
  async function handleTranscript(transcript) {
    const text = transcript.channel.alternatives[0].transcript;
    console.log('[Deepgram] Final transcript:', text);

    // 4) Send transcript to your AI (via OpenRouter)
    const aiReply = await sendToAI(text, { agent_id, voice_id, contact_name, address });

    // 5) Speak the AI reply back into the call (via ElevenLabs)
    await sendTTS(aiReply, ws, voice_id);
  }

  // POST to OpenRouter's Chat Completions endpoint
  async function sendToAI(userText, ctx) {
    const messages = [
      { role: 'system', content: 'You are an appointment confirmation agent.' },
      {
        role: 'user',
        content:
          `Context:\n` +
          `• Agent ID: ${ctx.agent_id}\n` +
          `• Contact: ${ctx.contact_name}\n` +
          `• Address: ${ctx.address}\n\n` +
          `User says: "${userText}"`
      }
    ];

    const resp = await fetch('https://openrouter.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages,
        stream: false
      })
    });
    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry, I didn't catch that.";
    console.log('[AI] reply:', reply);
    return reply;
  }

  // Stream ElevenLabs TTS audio back to Twilio
  async function sendTTS(text, wsConn, elevenVoiceId) {
    console.log('[TTS] Generating for:', text);
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        voice_settings: {
          stability: 0.75,
          similarity_boost: 0.75
        }
      })
    });
    if (!ttsRes.ok) {
      console.error('[TTS] error:', await ttsRes.text());
      return;
    }

    // Twilio expects outbound media messages with base64‐encoded chunks
    for await (const chunk of ttsRes.body) {
      wsConn.send(JSON.stringify({
        event: 'media',
        media: {
          track: 'outbound',
          payload: Buffer.from(chunk).toString('base64')
        }
      }));
    }
    // Signal end of audio
    wsConn.send(JSON.stringify({ event: 'stop' }));
  }
});

// Simple health check
app.get('/', (_req, res) => res.send('OK'));

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
