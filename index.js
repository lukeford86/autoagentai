// index.js
require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const WebSocket = require('ws');
const twilio = require('twilio');

// Load environment variables
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  PORT = 3000,
  HOST = '0.0.0.0'
} = process.env;

// Validate environment
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  fastify.log.error('❌ Missing one or more required environment variables.');
  process.exit(1);
}

// Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Register plugins
fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

// Serve TwiML
function generateTwiml(req) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${req.hostname}/twilio-stream?agent_id=${ELEVENLABS_AGENT_ID}" track="inbound" content-type="audio/x-mulaw;rate=8000"/>
  </Start>
</Response>`;
}

// TwiML endpoint
fastify.get('/twiml', async (req, reply) => {
  fastify.log.info('⚡ GET /twiml');
  reply.type('text/xml').send(generateTwiml(req));
});
fastify.post('/twiml', async (req, reply) => {
  fastify.log.info('⚡ POST /twiml');
  reply.type('text/xml').send(generateTwiml(req));
});

// Outbound call API
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  fastify.log.info({ phoneNumber }, '📞 Outbound call requested');

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://${req.hostname}/twiml`
    });
    fastify.log.info({ sid: call.sid }, '✅ Call started');
    reply.send({ status: 'ok', sid: call.sid });
  } catch (error) {
    fastify.log.error(error, '❌ Twilio call failed');
    reply.status(500).send({ error: error.message });
  }
});

// WebSocket stream bridge
fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  const agentId = req.query.agent_id || ELEVENLABS_AGENT_ID;
  const elevenUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${agentId}`;
  fastify.log.info(`🔌 Bridging Twilio <-> ElevenLabs: ${elevenUrl}`);

  const elevenSocket = new WebSocket(elevenUrl, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY
    }
  });

  elevenSocket.on('open', () => fastify.log.info('🧠 ElevenLabs connection opened'));
  elevenSocket.on('close', () => fastify.log.info('❎ ElevenLabs connection closed'));
  elevenSocket.on('error', (err) => fastify.log.error(err, '💥 ElevenLabs WebSocket error'));

  // Pipe audio Twilio -> ElevenLabs
  connection.socket.on('message', data => {
    if (elevenSocket.readyState === WebSocket.OPEN) {
      elevenSocket.send(data);
    }
  });

  // Pipe audio ElevenLabs -> Twilio
  elevenSocket.on('message', msg => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(msg);
    }
  });

  connection.socket.on('close', () => {
    elevenSocket.close();
  });
});

// Start server
fastify.listen({ port: Number(PORT), host: HOST }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Server ready at ${address}`);
});
