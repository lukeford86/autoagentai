// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 10000;

app.use(cors());

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  console.log('🔍 Health check');
  res.send('✅ AI Call Server is live');
});

// ─── TwiML endpoint ───────────────────────────────────────────────────────────
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('➡️ Received /twiml request:', req.query);

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  // build the raw URL (unescaped) for the WebSocket
  const wsUrl = `wss://${req.headers.host}/media?agent_id=${encodeURIComponent(agent_id)}&voice_id=${encodeURIComponent(voice_id)}&contact_name=${encodeURIComponent(contact_name)}&address=${encodeURIComponent(address)}`;
  console.log('🔗 Constructed WebSocket URL:', wsUrl);

  // embed it directly in the TwiML. Twilio will XML-escape it as needed.
  const twiml = `
    <Response>
      <Start>
        <Stream url="${wsUrl}" />
      </Start>
    </Response>
  `.trim();

  console.log('✅ [TwiML] Sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml);
});

// ─── WebSocket server setup ───────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  console.log('⏫ [Upgrade] incoming request:', req.url);
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  // Twilio may pass us "&amp;" literal in the URL if it didn't decode the XML entity,
  // so strip that out before parsing.
  console.log('✔️  [WebSocket] Connection upgrade for raw URL:', req.url);
  const rawUrl = req.url;
  const cleanedUrl = rawUrl.replace(/&amp;/g, '&');
  console.log('🔄 [WebSocket] Cleaned URL for parsing:', cleanedUrl);

  const params = new URLSearchParams(cleanedUrl.replace('/media?', ''));
  const agentId     = params.get('agent_id');
  const voiceId     = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address     = params.get('address');

  console.log(`✅ [WebSocket] Connection established for "${contactName}" @ "${address}"`);
  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ Missing WS query parameters after parsing!', { agentId, voiceId, contactName, address });
    ws.close(1008, 'Missing params');
    return;
  }

  // Generate your dynamic prompt
  const aiMessage = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  console.log('✏️  Sending text to ElevenLabs:', aiMessage);

  try {
    const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      headers: {
        'xi-api-key': elevenLabsApiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mulaw'
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

    response.data.on('data', chunk => {
      console.log(`📤 Streaming ${chunk.length} bytes to Twilio`);
      ws.send(chunk);
    });

    response.data.on('end', () => {
      console.log('✅ Finished streaming audio, closing WS');
      ws.close();
    });

  } catch (err) {
    console.error('💥 Error streaming from ElevenLabs:', err.response?.status, err.message);
    ws.close(1011, 'TTS error');
  }

  ws.on('message', data => {
    console.log('📥 Received media chunk (Twilio → us)');
  });

  ws.on('close', (code, reason) => {
    console.log(`🛑 [WebSocket] closed (code=${code} reason="${reason}")`);
  });

  ws.on('error', err => {
    console.error('🔴 [WebSocket] error:', err.message);
  });
});

// ─── Start server ───────────────────────────────────────────────────────────────
server.listen(port, () => {
  console.log(`🚀 AI Call Server running on port ${port}`);
});
