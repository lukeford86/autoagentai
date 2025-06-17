import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import dotenv from 'dotenv';

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

// Sample websocket endpoint
app.get('/ws', { websocket: true }, (socket, req) => {
  socket.send('hello from server');
  socket.on('message', message => {
    socket.send('echo: ' + message);
  });
});
console.log('Registered WS /ws');

// Dummy route handlers for isolation
const dummyHandler = async (req, reply) => {
  reply.send({ ok: true });
};

// Routes (dummy handlers)
app.post('/start-call', dummyHandler);
console.log('Registered POST /start-call (dummy)');
app.post('/call-status', dummyHandler);
console.log('Registered POST /call-status (dummy)');
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
