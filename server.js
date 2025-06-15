import Fastify from 'fastify';
import http from 'http';
import { WebSocketServer } from 'ws';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import dotenv from 'dotenv';
import { 
  handleCallWebhook, 
  handleMediaStreamSocket, 
  handleCallStatus,
  handleAmdStatus 
} from './twilioHandler.js';

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
const server = http.createServer(app.handler);

// Health check endpoint - handles both GET and HEAD
app.get('/', async (req, reply) => {
  if (req.method === 'HEAD') {
    return reply.send();
  }
  return reply.send({ status: 'ok' });
});
console.log('Registered GET /');

// Simple test endpoint for connectivity
app.get('/test', (req, reply) => {
  reply.send({ status: 'test ok' });
});
console.log('Registered GET /test');

// Attach WebSocket server
const wss = new WebSocketServer({
  server,
  path: '/media-stream',
  perMessageDeflate: false // Disable compression for better performance
});
wss.on('connection', (ws, request) => {
  handleMediaStreamSocket(ws, request, app.log);
});
wss.on('error', (error) => {
  app.log.error(error, 'WebSocket server error');
});
console.log('WebSocket server attached at /media-stream');

// Register plugins
app.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});
app.register(fastifyFormBody);
console.log('Registered CORS and formbody plugins');

// Routes
app.post('/start-call', handleCallWebhook);
console.log('Registered POST /start-call');
app.post('/call-status', handleCallStatus);
console.log('Registered POST /call-status');
app.post('/amd-status', handleAmdStatus);
console.log('Registered POST /amd-status');

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
try {
  server.listen(PORT, HOST, () => {
    app.log.info(`HTTP+WS Server listening on port ${PORT} (host: ${HOST})`);
    console.log(`HTTP+WS Server listening on port ${PORT} (host: ${HOST})`);
  });
} catch (err) {
  console.error('Server failed to start:', err);
  process.exit(1);
}
