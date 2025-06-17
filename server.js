import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import dotenv from 'dotenv';
import Twilio from 'twilio';
import { WebSocket as NodeWebSocket } from 'ws';

dotenv.config();

// Log non-secret environment variables for diagnostics
console.log('ENV:', {
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  PORT: process.env.PORT,
  TWILIO_ACCOUNT_SID: !!process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: !!process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: !!process.env.TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID: !!process.env.ELEVENLABS_AGENT_ID
});

// Validate required environment variables
const requiredEnvVars = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID'
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const app = Fastify({ 
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

// Register plugins
app.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});
app.register(fastifyFormBody);
app.register(websocket);
console.log('Registered CORS and formbody plugins');

const twilioClient = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Helper for ElevenLabs signed URL
async function getElevenLabsUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
  );
  if (!res.ok) throw new Error('Failed to get ElevenLabs signed URL');
  const { signed_url } = await res.json();
  return signed_url;
}

// Health check endpoint - handles both GET and HEAD
app.get('/', async (req, reply) => {
  if (req.method === 'HEAD') {
    return reply.send();
  }
  return reply.send({ status: 'ok' });
});
console.log('Registered GET /');

// Simple test endpoint for connectivity
app.get('/test', async (req, reply) => {
  return { status: 'test ok' };
});
console.log('Registered GET /test');

// Real /start-call POST handler
app.post('/start-call', async (req, reply) => {
  const { to, voicePrompt } = req.body;
  if (!to) {
    return reply.status(400).send({ error: 'Missing "to" field' });
  }
  const host = req.headers.host;
  const twiml = `\n<Response>\n  <Connect>\n    <Stream url=\"wss://${host}/media-stream\" />\n  </Connect>\n</Response>\n`;
  try {
    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml,
      statusCallback: `https://${host}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    req.log.info({ callSid: call.sid }, 'Twilio call initiated');
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err, 'Twilio call initiation failed');
    return reply.status(500).send({ error: 'Call initiation error' });
  }
});
console.log('Registered POST /start-call (real)');

// WebSocket handler for /media-stream
app.get('/media-stream', { websocket: true }, (connection, req) => {
  let elevenSocket;
  let streamSid;
  let hasReceivedInitialAudio = false;

  connection.socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      req.log.error(e, 'Invalid JSON from Twilio WS');
      return;
    }

    switch (msg.event) {
      case 'start':
        streamSid = msg.start.streamSid;
        try {
          const wsUrl = await getElevenLabsUrl();
          elevenSocket = new NodeWebSocket(wsUrl);
          elevenSocket.on('open', () => {
            elevenSocket.send(JSON.stringify({
              system_prompt: 'You are a friendly real estate agent offering free property valuations.',
              first_message: "Hi, I'm calling from Acme Realty. Would you be interested in a free valuation?",
              stream: true
            }));
          });
          elevenSocket.on('message', (data) => {
            const payload = Buffer.from(data).toString('base64');
            connection.socket.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload }
            }));
          });
        } catch (err) {
          req.log.error(err, 'Failed to open ElevenLabs WS');
          connection.socket.close();
        }
        break;
      case 'media':
        if (msg.media.track === 'inbound' && elevenSocket?.readyState === NodeWebSocket.OPEN) {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          elevenSocket.send(pcm);
        }
        break;
      case 'stop':
        elevenSocket?.close();
        connection.socket.close();
        break;
    }
  });

  connection.socket.on('close', () => {
    elevenSocket?.close();
  });
});
console.log('Registered WS /media-stream');

// Call status endpoint with detailed logging
app.post('/call-status', async (req, reply) => {
  const callStatus = req.body;
  req.log.info({
    callSid: callStatus.CallSid,
    callStatus: callStatus.CallStatus,
    callDuration: callStatus.CallDuration,
    direction: callStatus.Direction,
    from: callStatus.From,
    to: callStatus.To,
    timestamp: callStatus.Timestamp,
    rawStatus: callStatus
  }, 'Call status update received');
  
  return reply.send({ ok: true });
});
console.log('Registered POST /call-status with detailed logging');

// Dummy POST endpoints for now
const dummyHandler = async (req, reply) => {
  reply.send({ ok: true });
};
app.post('/amd-status', dummyHandler);
console.log('Registered POST /amd-status (dummy)');

// Error handling
app.setErrorHandler((error, request, reply) => {
  app.log.error(error);
  reply.status(500).send({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Fastify server listening on ${address}`);
  console.log(`Fastify server listening on ${address}`);
  console.log('Server startup complete');
});
