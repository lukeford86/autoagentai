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
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&"'\/]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      case '/': return '&#x2F;';
      default: return c;
    }
  });
}

// Outbound call trigger
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  console.log('📞 Triggering call to:', phoneNumber);

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://autoagentai.onrender.com/twiml`
    });
    console.log('✅ Twilio call initiated. SID:', call.sid);
    reply.send({ status: 'ok', sid: call.sid });
  } catch (err) {
    console.error('❌ Twilio error:', err);
    reply.status(500).send({ error: err.message });
  }
});

// Shared TwiML generator (no prompt or firstMessage)
function generateTwiml() {
  console.log('🧾 Generating TwiML with default agent settings');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://autoagentai.onrender.com/twilio-stream" track="inbound" content-type="audio/x-mulaw;rate=8000" />
  </Start>
  <Pause length="60" />
</Response>`;
}

// Handle TwiML callback (GET & POST)
fastify.route({
  method: ['GET', 'POST'],
  url: '/twiml',
  handler: async (req, reply) => {
    console.log(`🚦 [${req.method}] /twiml called`);
    reply.type('text/xml').send(generateTwiml());
  }
});

// WebSocket handler with ElevenLabs Conversational AI integration
fastify.get('/twilio-stream', { websocket: true }, (conn, req) => {
  console.log('🔌 Twilio stream opened');

  const agentId = ELEVENLABS_AGENT_ID;

  const elevenWs = new WebSocket('wss://api.elevenlabs.io/v1/conversation', {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  elevenWs.on('open', () => {
    console.log('🧠 Connected to ElevenLabs Conversational AI, agent_id:', agentId);
    elevenWs.send(JSON.stringify({ agent_id: agentId }));
    console.log('📝 Sent initial agent config to ElevenLabs');
  });

  conn.socket.on('message', (data) => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(data);
      console.log('🔄 Sent audio chunk to ElevenLabs, size:', data.length);
    }
  });

  elevenWs.on('message', (msg) => {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(msg);
      console.log('🗣️ Forwarded AI audio to Twilio, size:', msg.length);
    }
  });

  conn.socket.on('close', () => {
    console.log('❌ Twilio stream closed');
    elevenWs.close();
  });

  elevenWs.on('close', () => console.log('🔌 ElevenLabs WebSocket closed'));
  elevenWs.on('error', (err) => console.error('💥 ElevenLabs WebSocket error:', err));
});

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`🚀 Server running at ${address}`);
});
