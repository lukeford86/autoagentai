const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 10000;

app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.send('✅ AI Call Server is live');
});

// TwiML endpoint
app.all('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;

  if (!agent_id || !voice_id || !contact_name || !address) {
    console.error('❌ Missing required query parameters');
    return res.status(400).send('Missing required fields');
  }

  const wsUrl = `wss://${req.headers.host}/media?agent_id=${agent_id}&voice_id=${voice_id}&contact_name=${contact_name}&address=${address}`;

  const twiml = `
    <Response>
      <Start>
        <Stream url="${wsUrl}" />
      </Start>
    </Response>
  `;

  console.log('✅ [TwiML] /twiml HIT');
  res.set('Content-Type', 'text/xml');
  res.send(twiml.trim());
});

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/media')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  const urlParams = new URLSearchParams(req.url.replace('/media?', ''));
  const agentId = urlParams.get('agent_id');
  const voiceId = urlParams.get('voice_id');
  const contactName = urlParams.get('contact_name');
  const address = urlParams.get('address');

  console.log(`🎤 WebSocket connected for ${contactName} @ ${address}`);

  const aiMessage = `Hi ${contactName}, just confirming your appointment at ${address}.`;
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  const audioPath = path.join(__dirname, 'output.wav');

  try {
    const response = await axios({
      method: 'post',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: {
        'xi-api-key': elevenLabsApiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/wav'
      },
      responseType: 'stream',
      data: {
        text: aiMessage,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75
        },
        output_format: 'pcm-u-law' // Ensure μ-law 8000 Hz format
      }
    });

    const writer = fs.createWriteStream(audioPath);
    response.data.pipe(writer);

    writer.on('finish', () => {
      console.log('✅ Audio file saved in μ-law format from ElevenLabs');
      // Future: stream the audio file contents to Twilio WebSocket
    });

    writer.on('error', (err) => {
      console.error('❌ Error saving ElevenLabs audio:', err);
    });

  } catch (err) {
    console.error('💥 Error calling ElevenLabs API:', err.message);
  }

  ws.on('message', (data) => {
    console.log('📥 Media chunk received');
  });

  ws.on('close', () => {
    console.log('🛑 WebSocket closed');
  });

  ws.on('error', (err) => {
    console.error('💥 WebSocket error:', err.message);
  });
});

server.listen(port, () => {
  console.log(`✅ AI Call Server running on port ${port}`);
});
