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

// Simple test endpoint for connectivity
app.get('/test', (req, reply) => {
  reply.send({ status: 'test ok' });
});

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

// Register plugins
app.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});
app.register(fastifyFormBody);

// Routes
app.post('/start-call', handleCallWebhook);
app.post('/call-status', handleCallStatus);
app.post('/amd-status', handleAmdStatus);

// Error handling
app.setErrorHandler((error, request, reply) => {
  app.log.error(error);
  reply.status(500).send({ 
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  app.log.info(`HTTP+WS Server listening on port ${PORT} (host: ${HOST})`);
});
