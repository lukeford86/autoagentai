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
  <Say>Connecting you to Auto Agent AI assistant now.</Say>
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
  // Use agent_id in query string to authenticate and select voice
  const wsUrl = `wss://api.elevenlabs.io/v1/conversation?agent_id=${encodeURIComponent(agentId)}`;
  console.log('🔗 Connecting to ElevenLabs WS:', wsUrl);

  const elevenWs = new WebSocket(wsUrl, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Accept': 'application/json'
    }
  });

  elevenWs.on('open', () => {
    console.log('🧠 ElevenLabs WS open');
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

  elevenWs.on('close', () => console.log('🔌 ElevenLabs WS closed'));
  elevenWs.on('error', (err) => console.error('💥 ElevenLabs WS error:', err));
});

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`🚀 Server running at ${address}`);
});
