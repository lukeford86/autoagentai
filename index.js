// index.js
require('dotenv').config();
const Fastify = require('fastify');
// Using Node 18+ built-in fetch; no need for 'node-fetch'
const WebSocket = require('ws');
const twilio = require('twilio');

// Fastify plugins
const fastifyFormBody = require('@fastify/formbody');
const fastifyWs = require('@fastify/websocket');

// Load environment variables
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  SERVER_DOMAIN
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Missing Twilio credentials in environment variables');
  process.exit(1);
}
if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing ElevenLabs API key or Agent ID');
  process.exit(1);
}

// Initialize Fastify
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const DOMAIN = SERVER_DOMAIN || 'autoagentai.onrender.com';
const PORT = process.env.PORT || 8000;

// Helper: get a signed WebSocket URL from ElevenLabs
async function getSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`;
  const resp = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
  if (!resp.ok) throw new Error(`getSignedUrl failed: ${resp.status}`);
  const { signed_url } = await resp.json();
  return signed_url;
}

// Route: trigger outbound call via Twilio\ nfastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  try {
    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: `https://${DOMAIN}/twiml`
    });
    fastify.log.info('Twilio call SID:', call.sid);
    return reply.send({ status: 'ok', sid: call.sid });
  } catch (err) {
    fastify.log.error('Twilio error:', err);
    return reply.status(500).send({ error: err.message });
  }
});

// TwiML endpoint: instruct Twilio to connect call to WebSocket
fastify.route({
  method: ['GET','POST'],
  url: '/twiml',
  handler: (req, reply) => {
    fastify.log.info(`[${req.method}] /twiml called`);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${DOMAIN}/media-stream" />
  </Connect>
</Response>`;
    reply.type('text/xml').send(twiml);
  }
});

// WebSocket: handle Twilio media and forward to ElevenLabs
fastify.register(async (instance) => {
  instance.get('/media-stream', { websocket: true }, (conn, req) => {
    fastify.log.info('Twilio media stream opened');
    let streamSid;
    let callSid;
    let elevenWs;

    // Setup ElevenLabs WS
    getSignedUrl().then((signedUrl) => {
      fastify.log.info('Connecting to ElevenLabs WS:', signedUrl);
      elevenWs = new WebSocket(signedUrl);
      elevenWs.on('open', () => fastify.log.info('ElevenLabs WS open'));
      elevenWs.on('error', (err) => fastify.log.error('ElevenLabs WS error:', err));
      elevenWs.on('close', () => fastify.log.info('ElevenLabs WS closed'));

      // Relay audio from ElevenLabs back to Twilio
      elevenWs.on('message', (data) => {
        if (conn.socket.readyState === WebSocket.OPEN) {
          conn.socket.send(data);
          fastify.log.debug('Sent AI audio to Twilio, bytes:', data.length);
        }
      });
    }).catch(err => fastify.log.error('Failed to setup ElevenLabs WS:', err));

    // Handle Twilio media events
    conn.socket.on('message', (msg) => {
      try {
        const event = JSON.parse(msg);
        switch (event.event) {
          case 'start':
            streamSid = event.start.streamSid;
            callSid = event.start.callSid;
            fastify.log.info(`Stream started: ${streamSid}, Call: ${callSid}`);
            break;
          case 'media':
            if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
              const payload = event.media.payload;
              elevenWs.send(JSON.stringify({ user_audio_chunk: payload }));
              fastify.log.debug('Forwarded user audio chunk');
            }
            break;
          case 'stop':
            fastify.log.info(`Stream ${streamSid} stopped`);
            if (elevenWs) elevenWs.close();
            break;
          default:
            fastify.log.debug('Unhandled Twilio event:', event.event);
        }
      } catch (e) {
        fastify.log.error('Error processing Twilio message:', e);
      }
    });

    conn.socket.on('close', () => {
      fastify.log.info('Twilio connection closed');
      if (elevenWs) elevenWs.close();
    });
  });
});

// Start server
fastify.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`🚀 Server running at ${address}`);
});
