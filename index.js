// index.js
require('dotenv').config();
const fastify = require('fastify')({ logger: false });
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
  console.error('❌ Missing one or more required environment variables.');
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
  console.log(`🧭 Generated stream URL: ${streamUrl}`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" track="inbound" content-type="audio/x-mulaw;rate=8000" />
  </Start>
</Response>`;

  console.log('📤 Sending TwiML response');
  reply.type('text/xml').send(xml);
}

fastify.get('/twiml', handleTwiML);
fastify.post('/twiml', handleTwiML);

// Outbound call trigger
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  console.log(`📞 Outbound call requested to ${phoneNumber}`);

  try {
    const twimlUrl = `https://${req.hostname}/twiml`;
    console.log(`📡 TwiML URL: ${twimlUrl}`);

    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: twimlUrl
    });
    console.log(`✅ Twilio call initiated. SID: ${call.sid}`);
    return { status: 'ok', sid: call.sid };
  } catch (err) {
    console.error(`❌ Failed to create Twilio call: ${err.message}`);
    reply.status(500).send({ error: err.message });
  }
});

// WebSocket: Twilio <-> ElevenLabs
fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  const agentId = req.query.agent_id || ELEVENLABS_AGENT_ID;
  const elevenURL = `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${agentId}`;

  console.log('🔌 Twilio WebSocket connected');
  console.log(`🌐 Connecting to ElevenLabs using Agent ID: ${agentId}`);
  console.log(`🔗 ElevenLabs WS URL: ${elevenURL}`);

  const elevenWs = new WebSocket(elevenURL, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  elevenWs.on('open', () => console.log('✅ ElevenLabs WebSocket open'));
  elevenWs.on('close', () => console.log('🔌 ElevenLabs WebSocket closed'));
  elevenWs.on('error', err => console.error(`❌ ElevenLabs WebSocket error: ${err.message}`));

  connection.socket.on('message', (audioChunk) => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      console.log('📤 Sending audio to ElevenLabs');
      elevenWs.send(audioChunk);
    }
  });

  elevenWs.on('message', (aiAudio) => {
    if (connection.socket.readyState === WebSocket.OPEN) {
      console.log('📥 Sending audio back to Twilio');
      connection.socket.send(aiAudio);
    }
  });

  connection.socket.on('close', () => {
    console.log('🔌 Twilio WebSocket closed');
    elevenWs.close();
  });
});

// Start server
fastify.listen({ port: Number(PORT), host: HOST }, (err, address) => {
  if (err) {
    console.error(`❌ Server failed to start: ${err.message}`);
    process.exit(1);
  }
  console.log(`🚀 Server listening at ${address}`);
});
