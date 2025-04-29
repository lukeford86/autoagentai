const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 10000;

app.use(cors());

// Health check
app.get('/', (req, res) => {
  console.log('🔍 Health check');
  res.send('✅ AI Call Server is live');
});

// Helper to escape XML
const escapeXml = (unsafe) => unsafe.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

// TwiML endpoint
app.all('/twiml', (req, res) => {
  console.log('➡️ Received /twiml request:', req.query);
  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters', { agent_id, voice_id, contact_name, address });
    return res.status(400).send('Missing required fields');
  }

  const wsUrl = `wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${contact_name}&address=${address}`;
  const escapedWsUrl = escapeXml(wsUrl);
  console.log('🔗 Constructed WebSocket URL:', wsUrl);
  console.log('🔄 Escaped WebSocket URL for XML:', escapedWsUrl);

  const twiml = `
    <Response>
      <Start>
        <Stream url="${escapedWsUrl}" />
      </Start>
    </Response>
  `;

  console.log('✅ [TwiML] Sending TwiML to Twilio');
  res.set('Content-Type', 'text/xml');
  res.send(twiml.trim());
});

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  console.log('🔄 HTTP upgrade request for WebSocket:', req.url);
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('✅ WebSocket handshake successful');
      wss.emit('connection', ws, req);
    });
  } else {
    console.error('❌ Unknown upgrade path, destroying socket');
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  console.log('🟢 WebSocket connection established');
  const urlParams = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId = urlParams.get('agent_id');
  const voiceId = urlParams.get('voice_id');
  const contactName = urlParams.get('contact_name');
  const address = urlParams.get('address');
  console.log('📦 Connection params:', { agentId, voiceId, contactName, address });

  const aiMessage = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  console.log('🧠 AI message to synthesize:', aiMessage);

  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsApiKey) {
    console.error('❌ Missing ELEVENLABS_API_KEY');
    ws.close();
    return;
  }

  try {
    console.log('🚀 Calling ElevenLabs API for TTS stream');
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
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      }
    });

    console.log('✅ Received HTTP 200 from ElevenLabs, streaming audio...');
    response.data.on('data', (chunk) => {
      console.log(`🔊 Streaming audio chunk (${chunk.length} bytes)`);
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(chunk);
        } catch (sendErr) {
          console.error('❌ Error sending chunk to WebSocket:', sendErr.message);
        }
      }
    });

    response.data.on('end', () => {
      console.log('🛑 ElevenLabs audio stream ended');
      ws.close();
    });

    response.data.on('error', (err) => {
      console.error('💥 Stream error from ElevenLabs:', err.message);
      ws.close();
    });

  } catch (err) {
    console.error('💥 Error calling ElevenLabs API:', err.message);
    ws.close();
  }

  ws.on('message', (data) => console.log('📥 Received message from Twilio (ignored)'));
  ws.on('close', () => console.log('🔒 WebSocket closed by Twilio'));  
  ws.on('error', (err) => console.error('💥 WebSocket error:', err.message));
});

server.listen(port, () => console.log(`🚀 AI Call Server running on port ${port}`));
