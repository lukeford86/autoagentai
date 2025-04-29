// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const { URLSearchParams } = require('url');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 10000;

app.use(cors());

// ——— Health check ———
app.get('/', (req, res) => {
  console.log('🔍 Health check');
  res.send('✅ AI Call Server is live');
});

// ——— TwiML endpoint ———
// returns <Connect><Stream> so Media Streams are bidirectional
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;

  console.log('➡️ Received /twiml request:', { agent_id, voice_id, contact_name, address });

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  // assemble websocket URL
  const rawWsUrl = `wss://${req.headers.host}/media` +
    `?agent_id=${encodeURIComponent(agent_id)}` +
    `&voice_id=${encodeURIComponent(voice_id)}` +
    `&contact_name=${encodeURIComponent(contact_name)}` +
    `&address=${encodeURIComponent(address)}`;

  console.log('🔗 Constructed WebSocket URL:', rawWsUrl);

  // escape for XML attribute (just ampersands here)
  const wsUrlXml = rawWsUrl.replace(/&/g, '&amp;');

  console.log('🔄 Escaped WebSocket URL for XML:', wsUrlXml);

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrlXml}" />
      </Connect>
    </Response>
  `.trim();

  console.log('✅ [TwiML] Sending TwiML to Twilio');
  res.set('Content-Type', 'application/xml');
  res.send(twiml);
});

// ——— WebSocket server for Media Streams ———
const wss = new WebSocket.Server({ noServer: true });

// handle HTTP → WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  console.log('⬆️ [Upgrade] incoming request:', req.url);
  if (req.url.startsWith('/media')) {
    console.log('➡️ [Upgrade] handling WebSocket upgrade');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  // parse query params out of req.url
  const params = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId     = params.get('agent_id');
  const voiceId     = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address     = params.get('address');

  console.log(`✅ [WebSocket] Connection established for ${contactName} @ ${address}`);

  // The message we want to speak
  const aiMessage = `Hi ${contactName}, just confirming your appointment at ${address}.`;

  // ElevenLabs credentials
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsApiKey) {
    console.error('❌ Missing ELEVENLABS_API_KEY in env');
    ws.close();
    return;
  }

  // Stream TTS from ElevenLabs into the call
  try {
    console.log('🎤 Sending text to ElevenLabs:', aiMessage);
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers: {
        'xi-api-key': elevenLabsApiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mulaw'         // ensure μ-law 8kHz as Twilio expects
      },
      responseType: 'stream',
      data: {
        text: aiMessage,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75
        }
      }
    });

    response.data.on('data', (chunk) => {
      // Twilio will play whatever we send here
      ws.send(chunk);
    });

    response.data.on('end', () => {
      console.log('✅ Finished streaming audio to Twilio, closing WS');
      ws.close();
    });

    response.data.on('error', (err) => {
      console.error('💥 ElevenLabs stream error:', err);
      ws.close();
    });
  } catch (err) {
    console.error('💥 Error streaming from ElevenLabs:', err.response?.status, err.message);
    ws.close();
  }

  // log if Twilio ever sends media back (caller voice)
  ws.on('message', (data) => {
    console.log('📥 [WebSocket] Received media chunk of length', data.length);
  });

  ws.on('close', (code, reason) => {
    console.log(`🛑 [WebSocket] closed (code: ${code} reason: ${reason || '—'})`);
  });

  ws.on('error', (err) => {
    console.error('💥 [WebSocket] error:', err.message);
  });
});

// start HTTP + WS server
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
