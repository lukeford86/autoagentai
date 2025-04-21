// index.js
require('dotenv').config();
const fastify = require('fastify')();
const twilio = require('twilio');
const WebSocket = require('ws');

// Register plugins
fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

// Environment variables
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

// Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Escape XML characters to prevent invalid TwiML
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

// Endpoint to trigger outbound call
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

// Generate TwiML for Twilio callbacks
function generateTwiml() {
  console.log('🧾 Generating TwiML with default agent settings');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://autoagentai.onrender.com/twilio-stream" track="inbound" content-type="audio/x-mulaw;rate=8000" />
  </Start>
</Response>`;
}

// Handle TwiML callback (GET & POST)
fastify.route({
  method: ['GET', 'POST'],
  url: '/twiml',
  handler: (req, reply) => {
    console.log(`🚦 [${req.method}] /twiml called`);
    reply.type('text/xml').send(generateTwiml());
  }
});

// WebSocket endpoint for streaming audio to ElevenLabs
fastify.get('/twilio-stream', { websocket: true }, (conn, req) => {
  console.log('🔌 Twilio stream opened');

  const agentId = ELEVENLABS_AGENT_ID;
  const wsUrl = `wss://api.elevenlabs.io/v1/conversation?agent_id=${encodeURIComponent(agentId)}`;
  console.log('🔗 Connecting to ElevenLabs WS:', wsUrl);

  const elevenWs = new WebSocket(wsUrl, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  elevenWs.on('open', () => console.log('🧠 ElevenLabs WS open'));
  elevenWs.on('error', (err) => console.error('💥 ElevenLabs WS error:', err));
  elevenWs.on('close', () => console.log('🔌 ElevenLabs WS closed'));

  // Forward inbound caller audio to ElevenLabs
  conn.socket.on('message', (data) => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(data);
      console.log('🔄 Sent audio chunk to ElevenLabs, size:', data.length);
    }
  });

  // Forward AI audio back to Twilio
  elevenWs.on('message', (msg) => {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(msg);
      console.log('🗣️ Forwarded AI audio to Twilio, size:', msg.length);
    }
  });

  // Clean up on close
  conn.socket.on('close', () => {
    console.log('❌ Twilio stream closed');
    elevenWs.close();
  });
});

// Start server
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`🚀 Server running at ${address}`);
});
