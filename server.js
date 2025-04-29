const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const { Deepgram } = require('@deepgram/sdk');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Load environment variables
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const resembleApiKey = process.env.RESEMBLE_API_KEY;

// Setup Deepgram
const deepgram = new Deepgram(deepgramApiKey);

// --- Serve dynamic TwiML for Twilio call setup ---
app.get('/twiml', (req, res) => {
  const agentId = req.query.agent_id;
  const voiceId = req.query.voice_id;

  if (!agentId || !voiceId) {
    return res.status(400).send('Missing agent_id or voice_id');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agentId}&voice_id=${voiceId}`,
  });

  res.type('text/xml');
  res.send(response.toString());
});

// --- Create HTTP server and WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

// --- WebSocket Connection Handler ---
wss.on('connection', (ws, req) => {
  console.log('📞 Twilio Media Stream connected');

  const params = new URLSearchParams(req.url.split('?')[1]);
  const agentId = params.get('agent_id');
  const voiceId = params.get('voice_id');

  console.log(`🎯 Agent ID: ${agentId}, Voice ID: ${voiceId}`);

  // Connect to Deepgram Streaming API
  const deepgramSocket = deepgram.transcription.live({
    language: 'en-AU',
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',
    sample_rate: 8000,
  });

  deepgramSocket.on('open', () => {
    console.log('🔗 Connected to Deepgram');
  });

  deepgramSocket.on('transcriptReceived', async (data) => {
    const transcript = data.channel.alternatives[0].transcript;
    if (transcript && transcript.length > 0) {
      console.log(`📝 Deepgram Transcript: ${transcript}`);

      try {
        const gptReply = await generateReplyFromGPT(transcript);
        const voiceStream = await streamVoiceFromResemble(gptReply, voiceId);

        // Send Resemble audio stream back to Twilio
        voiceStream.on('data', (chunk) => {
          if (ws.readyState === WebSocket.OPEN) {
            const payload = Buffer.from(chunk).toString('base64');
            const message = JSON.stringify({
              event: 'media',
              media: {
                payload: payload
              }
            });
            ws.send(message);
          }
        });

        voiceStream.on('end', () => {
          console.log('✅ Finished streaming GPT reply back to Twilio');
        });

      } catch (error) {
        console.error('❌ Error in AI processing:', error);
      }
    }
  });

  deepgramSocket.on('error', (error) => {
    console.error('Deepgram Socket Error:', error);
  });

  deepgramSocket.on('close', () => {
    console.log('🔒 Deepgram WebSocket closed');
  });

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.event === 'start') {
      console.log(`✅ Call started: ${message.streamSid}`);
    }

    if (message.event === 'media') {
      const audioData = message.media.payload;
      const buffer = Buffer.from(audioData, 'base64');

      if (deepgramSocket.readyState === 1) {
        deepgramSocket.send(buffer);
      }
    }

    if (message.event === 'stop') {
      console.log(`🛑 Call ended: ${message.streamSid}`);
      ws.close();
      deepgramSocket.finish();
    }
  });

  ws.on('close', () => {
    console.log('🔒 Twilio WebSocket connection closed');
    if (deepgramSocket.readyState === 1) {
      deepgramSocket.finish();
    }
  });
});

// --- Functions ---

async function generateReplyFromGPT(userText) {
  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'gpt-4o', // or another model
    messages: [
      { role: "system", content: "You are a friendly real estate AI helping to book free property valuations. Be natural and conversational." },
      { role: "user", content: userText }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json'
    }
  });

  const reply = response.data.choices[0].message.content;
  console.log(`🤖 GPT Reply: ${reply}`);
  return reply;
}

async function streamVoiceFromResemble(replyText, voiceId) {
  const response = await axios({
    method: 'POST',
    url: `https://app.resemble.ai/api/v2/projects/${voiceId}/clips/stream`,
    headers: {
      Authorization: `Token token=${resembleApiKey}`,
      'Content-Type': 'application/json',
    },
    data: {
      text: replyText,
      voice: voiceId,
      output_format: 'mulaw',
      sample_rate: 8000
    },
    responseType: 'stream'
  });

  return response.data;
}

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
