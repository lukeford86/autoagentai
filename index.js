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
  fastify.log.error('Missing one or more required environment variables.');
  process.exit(1);
}

// Initialize Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Register Fastify plugins
fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

/**
 * Unified TwiML endpoint (GET for browser, POST for Twilio)
 * Streams raw audio to our /twilio-stream WebSocket
 */
async function handleTwiML(req, reply) {
  fastify.log.info({ method: req.method, url: req.url }, 'TwiML endpoint hit');

  // Build XML that immediately opens the audio stream
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${req.hostname}/twilio-stream?agent_id=${ELEVENLABS_AGENT_ID}" track="inbound" content-type="audio/x-mulaw;rate=8000" />
  </Start>
</Response>`;

  reply.type('text/xml').send(xml);
}

fastify.get('/twiml', handleTwiML);
fastify.post('/twiml', handleTwiML);

/**
 * Outbound call trigger
 * Expects JSON body: { phoneNumber: "+15558675309" }
 */
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  fastify.log.info({ phoneNumber }, 'Outbound call requested');

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://${req.hostname}/twiml`
    });
    fastify.log.info({ sid: call.sid }, 'Twilio call initiated');
    return { status: 'ok', sid: call.sid };
  } catch (err) {
    fastify.log.error(err, 'Failed to create Twilio call');
    reply.status(500).send({ error: err.message });
  }
});

/**
 * WebSocket bridge:
 * - Receives raw audio from Twilio
 * - Forwards to ElevenLabs ConvAI
 * - Pipes AI-generated audio back into Twilio
 */
fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  fastify.log.info('Twilio WebSocket connection established');

  const elevenURL = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`;
  fastify.log.info({ elevenURL }, 'Connecting to ElevenLabs ConvAI');

  const elevenWs = new WebSocket(elevenURL, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  elevenWs.on('open', () => fastify.log.info('Connected to ElevenLabs ConvAI'));
  elevenWs.on('error', err => fastify.log.error(err, 'ElevenLabs WS error'));
  elevenWs.on('close', () => fastify.log.info('ElevenLabs WS closed'));

  // Twilio -> ElevenLabs
  connection.socket.on('message', (audioChunk) => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(audioChunk);
      fastify.log.debug('Forwarded audio chunk to ElevenLabs');
    }
  });

  // ElevenLabs -> Twilio
  elevenWs.on('message', (aiAudio) => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(aiAudio);
      fastify.log.debug('Forwarded AI audio chunk to Twilio');
    }
  });

  // Cleanup on close
  connection.socket.on('close', () => {
    fastify.log.info('Twilio WS closed');
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
