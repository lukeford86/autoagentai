// index.js
require('dotenv').config();
const fastify = require('fastify')();
const twilio = require('twilio');

fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Outbound call trigger
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber, prompt, firstMessage } = req.body;
  console.log('📞 Triggering call to:', phoneNumber);

  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://${req.hostname}/twiml?prompt=${encodeURIComponent(prompt)}&firstMessage=${encodeURIComponent(firstMessage)}`
    });

    reply.send({ status: 'ok', sid: call.sid });
  } catch (err) {
    console.error('❌ Twilio error:', err);
    reply.status(500).send({ error: err.message });
  }
});

// Generate TwiML that starts streaming
fastify.get('/twiml', async (req, reply) => {
  const { prompt, firstMessage } = req.query;
  const response = `<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<Response>
  <Start>
    <Stream url=\"wss://${req.hostname}/twilio-stream\" track=\"inbound\" content-type=\"audio/x-mulaw;rate=8000\" />
  </Start>
  <Say>${firstMessage}</Say>
</Response>`;

  reply.type('text/xml').send(response);
});

// WebSocket handler (we'll connect this to ElevenLabs soon)
fastify.get('/twilio-stream', { websocket: true }, (conn, req) => {
  console.log('🔌 Twilio stream opened');

  conn.socket.on('message', (data) => {
    // TODO: forward audio to ElevenLabs via WebSocket
    console.log('🎙️ Audio chunk received:', data.length);
  });

  conn.socket.on('close', () => {
    console.log('❌ Twilio stream closed');
  });
});

fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`🚀 Server running at ${address}`);
});
