// index.js
require('dotenv').config();
const fastify = require('fastify')();
const twilio = require('twilio');
const WebSocket = require('ws');

fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Escape XML characters
tonscapeXml = (unsafe) =>
  unsafe.replace(/[<>&'"/]/g, (c) => ({
    '<': '&lt;'),
    '>': '&gt;'),
    '&': '&amp;'),
    "'": '&apos;'),
    '"': '&quot;'),
    '/': '&#x2F;')
  })[c]);

// Outbound call trigger
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber, prompt, firstMessage } = req.body;
  console.log('📞 Triggering call to:', phoneNumber);
  console.log('📤 Prompt:', prompt);
  console.log('📤 First message:', firstMessage);

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://autoagentai.onrender.com/twiml?prompt=${encodeURIComponent(prompt)}&firstMessage=${encodeURIComponent(firstMessage)}`
    });
    console.log('✅ Twilio call initiated. SID:', call.sid);
    reply.send({ status: 'ok', sid: call.sid });
  } catch (err) {
    console.error('❌ Twilio error:', err);
    reply.status(500).send({ error: err.message });
  }
});

// Shared TwiML generator
function generateTwiml(prompt, firstMessage) {
  const safeMessage = escapeXml(firstMessage || 'Hi! This is Auto Agent AI calling.');
  console.log('🧾 Generating TwiML with prompt:', prompt);
  console.log('🧾 Generating TwiML with message:', safeMessage);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://autoagentai.onrender.com/twilio-stream" track="inbound" content-type="audio/x-mulaw;rate=8000" />
  </Start>
  <Say>${safeMessage}</Say>
  <Pause length="60" />
</Response>`;
}

// Handle GET requests (for browser)
fastify.get('/twiml', async (req, reply) => {
  const prompt = req.query.prompt || '';
  const firstMessage = req.query.firstMessage || '';
  console.log('🚦 [GET] /twiml called with:', req.query);
  reply.type('text/xml').send(generateTwiml(prompt, firstMessage));
});

// Handle POST requests (Twilio)
fastify.post('/twiml', async (req, reply) => {
  const prompt = req.body.prompt || '';
  const firstMessage = req.body.firstMessage || '';
  console.log('🚦 [POST] /twiml called with:', req.body);
  reply.type('text/xml').send(generateTwiml(prompt, firstMessage));
});

// WebSocket handler with ElevenLabs Conversational AI integration
fastify.get('/twilio-stream', { websocket: true }, (conn, req) => {
  console.log('🔌 Twilio stream opened');
  console.log('🔍 Request query:', req.query);

  const firstMessage = req.query.firstMessage || 'Hi! This is Auto Agent AI calling.';
  const prompt = req.query.prompt || '';
  const agentId = ELEVENLABS_AGENT_ID;

  const elevenWs = new WebSocket('wss://api.elevenlabs.io/v1/conversation', {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    }
  });

  elevenWs.on('open', () => {
    console.log('🧠 Connected to ElevenLabs Conversational AI');
    elevenWs.send(JSON.stringify({
      agent_id: agentId,
      first_message: firstMessage,
      prompt: prompt
    }));
    console.log('📝 Sent initial config to ElevenLabs');
  });

  conn.socket.on('message', (data) => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(data);
      console.log('🔄 Sent audio chunk to ElevenLabs');
    }
  });

  elevenWs.on('message', (msg) => {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(msg);
      console.log('🗣️ Forwarded AI audio to Twilio');
    }
  });

  conn.socket.on('close', () => {
    console.log('❌ Twilio stream closed');
    elevenWs.close();
  });

  elevenWs.on('close', () => {
    console.log('🔌 ElevenLabs WebSocket closed');
  });

  elevenWs.on('error', (err) => {
    console.error('💥 ElevenLabs WebSocket error:', err);
  });
});

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`🚀 Server running at ${address}`);
});
