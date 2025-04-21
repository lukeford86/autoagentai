// index.js
require('dotenv').config();
const fastify = require('fastify')();
const twilio = require('twilio');
const { WebSocket } = require('ws');

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

// Generate TwiML for Twilio callbacks (streams audio both ways)
function generateTwiml() {
  console.log('🧾 Generating TwiML for streaming');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="wss://${process.env.SERVER_DOMAIN || 'autoagentai.onrender.com'}/twilio-stream" track="both" />
  </Start>
  <Pause length="600" />
</Response>`;
}
    console.log('✅ Twilio call initiated. SID:', call.sid);
    reply.send({ status: 'ok', sid: call.sid });
  } catch (err) {
    console.error('❌ Twilio error:', err);
    reply.status(500).send({ error: err.message });
  }
});

// TwiML endpoint for Twilio
fastify.route({
  method: ['GET','POST'],
  url: '/twiml',
  handler: (req, reply) => {
    console.log(`🚦 [${req.method}] /twiml called`);
    reply.type('text/xml').send(generateTwiml());
  }
});

// WebSocket endpoint for Twilio media stream
fastify.get('/twilio-stream', { websocket: true }, (conn, req) => {
  console.log('🔌 Twilio stream opened');

  // Correct ElevenLabs WebSocket URL
  const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`;
  console.log('🔗 Connecting to ElevenLabs WS:', wsUrl);

  const elevenWs = new WebSocket(wsUrl, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  elevenWs.on('open', () => console.log('🧠 ElevenLabs WS open'));  
  elevenWs.on('error', err => console.error('💥 ElevenLabs WS error:', err));
  elevenWs.on('close', () => console.log('🔌 ElevenLabs WS closed'));

  // forward inbound audio to ElevenLabs
  conn.socket.on('message', data => {
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.send(data);
      console.log('🔄 Sent audio chunk to ElevenLabs:', data.length);
    }
  });

  // forward AI audio back to Twilio
  elevenWs.on('message', msg => {
    if (conn.socket.readyState === WebSocket.OPEN) {
      conn.socket.send(msg);
      console.log('🗣️ Forwarded AI audio to Twilio:', msg.length);
    }
  });

  conn.socket.on('close', () => {
    console.log('❌ Twilio stream closed');
    elevenWs.close();
  });
});

// Start server
const PORT = process.env.PORT || 3000;
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`🚀 Server running at ${address}`);
});
