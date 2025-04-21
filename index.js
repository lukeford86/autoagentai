// index.js
require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const WebSocket = require('ws');
const twilio = require('twilio');

// Load configuration from environment
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  PORT = 3000,
  HOST = '0.0.0.0'
} = process.env;

// Validate required env vars
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  fastify.log.error('❌ Missing one or more required environment variables.');
  process.exit(1);
}

// Initialize Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Register Fastify plugins
fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

// Serve TwiML for Twilio
async function handleTwiML(req, reply) {
  const hostname = req.hostname.includes('localhost') ? `localhost:${PORT}` : req.hostname;
  const streamUrl = `wss://${hostname}/twilio-stream?agent_id=${ELEVENLABS_AGENT_ID}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" track="inbound" content-type="audio/x-mulaw;rate=8000" />
  </Start>
</Response>`;

  reply.type('text/xml').send(xml);
}

fastify.get('/twiml', handleTwiML);
fastify.post('/twiml', handleTwiML);

// Outbound call trigger
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  fastify.log.info(`📞 Outbound call requested to ${phoneNumber}`);

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://${req.hostname}/twiml`
    });
    fastify.log.info(`✅ Twilio call initiated. SID: ${call.sid}`);
    return { status: 'ok', sid: call.sid };
  } catch (err) {
    fastify.log.error(err, '❌ Failed to create Twilio call');
    reply.status(500).send({ error: err.message });
  }
});

// WebSocket: Twilio <-> ElevenLabs
fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  fastify.log.info('🔌 Twilio WebSocket connected');

  const elevenURL = `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${ELEVENLABS_AGENT_ID}`;
  fastify.log.info(`🌐 Connecting to ElevenLabs: ${elevenURL}`);

  const elevenWs = new WebSocket(elevenURL, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  elevenWs.on('open', () => fastify.log.info('✅ ElevenLabs WebSocket open'));
  elevenWs.on('close', () => fastify.log.info('🔌 ElevenLabs WebSocket closed'));
  elevenWs.on('error', err => fastify.log.error(err, '❌ ElevenLabs WebSocket error'));

  connection.socket.on('message', (audioChunk) => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(audioChunk);
    }
  });

  elevenWs.on('message', (aiAudio) => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(aiAudio);
    }
  });

  connection.socket.on('close', () => {
    fastify.log.info('🔌 Twilio WebSocket closed');
    elevenWs.close();
  });
});

// Start server
fastify.listen({ port: Number(PORT), host: HOST }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Server listening at ${address}`);
});
