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

// --- Serve TwiML ---
app.all('/twiml', (req, res) => {
  console.log('✅ [TwiML] /twiml hit');

  const params = req.method === 'GET' ? req.query : req.body;
  const agentId = params.agent_id;
  const voiceId = params.voice_id;
  const contactName = params.contact_name;
  const address = params.address;

  if (!agentId || !voiceId || !contactName || !address) {
    console.error('❌ [TwiML] Missing fields:', { agentId, voiceId, contactName, address });
    return res.status(400).send('Missing required fields');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agentId}&voice_id=${voiceId}&contact_name=${encodeURIComponent(contactName)}&address=${encodeURIComponent(address)}`
  });

  res.type('text/xml');
  res.send(response.toString());
});

// --- Create HTTP server and WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

// --- WebSocket Connection ---
wss.on('connection', (ws, req) => {
  console.log('📞 [Twilio] WebSocket connection established');

  const params = new URLSearchParams(req.url.split('?')[1]);
  const agentId = params.get('agent_id');
  const voiceId = params.get('voice_id');
  const contactName = params.get('contact_name');
  const address = params.get('address');

  console.log(`🎯 [Twilio] Params Received:`, { agentId, voiceId, contactName, address });

  const deepgramSocket = deepgram.transcription.live({
    language: 'en-AU',
    punctuate: true,
    interim_results: false,
    encoding: 'mulaw',
    sample_rate: 8000,
  });

  deepgramSocket.on('open', () => {
    console.log('🔗 [Deepgram] Connected successfully');
  });

  deepgramSocket.on('error', (error) => {
    console.error('❌ [Deepgram] Connection Error:', error);
  });

  deepgramSocket.on('close', () => {
    console.log('🔒 [Deepgram] Socket closed');
  });

  ws.on('message', async (data) => {
    const message = JSON.parse(data);

    console.log('📥 [Twilio] Message Event:', message.event);

    if (message.event === 'start') {
      console.log(`✅ [Twilio] Call Started: ${message.streamSid}`);
    }

    if (message.event === 'media') {
      console.log('🎤 [Twilio] Media Packet Received');
      const audioData = message.media.payload;
      const buffer = Buffer.from(audioData, 'base64');

      if (deepgramSocket.readyState === 1) {
        deepgramSocket.send(buffer);
      } else {
        console.warn('⚠️ [Deepgram] Not ready to receive audio');
      }
    }

    if (message.event === 'stop') {
      console.log(`🛑 [Twilio] Call Stopped: ${message.streamSid}`);
      ws.close();
      deepgramSocket.finish();
    }
  });

  ws.on('close', () => {
    console.log('🔒 [Twilio] WebSocket closed');
    if (deepgramSocket.readyState === 1) {
      deepgramSocket.finish();
    }
  });

  ws.on('error', (error) => {
    console.error('❌ [Twilio] WebSocket Error:', error);
  });
});

// --- GPT Reply Function ---
async function generateReplyFromGPT(userText, contactName, address) {
  const systemPrompt = `You are a friendly real estate agent AI assistant. You are calling ${contactName} about their property at ${address}. Offer a free property valuation, mention recent sales nearby, and book a time for a free update. Be natural, professional, and confident.`;

  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json'
    }
  });

  const reply = response.data.choices[0].message.content;
  console.log(`🤖 [GPT Reply]: ${reply}`);
  return reply;
}

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
