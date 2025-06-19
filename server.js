import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import dotenv from 'dotenv';
import Twilio from 'twilio';
import { handleCallWebhook, handleMediaStreamSocket, handleCallStatus, handleAmdStatus } from './twilioHandler.js';
import { config } from 'dotenv';

// Load environment variables from .env file
config();

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
  logger: process.env.NODE_ENV === 'production' 
    ? { level: process.env.LOG_LEVEL || 'info' } // Simple logger for production
    : { // Pretty logger for development
        level: process.env.LOG_LEVEL || 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        },
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

// Health check endpoint
app.get('/health', async (request, reply) => {
  return { status: 'ok' };
});
console.log('Registered GET /health');

// Root endpoint
app.get('/', async (request, reply) => {
  return { 
    service: 'AutoAgentAI Twilio + ElevenLabs Integration',
    status: 'running',
    endpoints: {
      health: '/health',
      envCheck: '/env-check',
      testMcpBridge: '/test-mcp-bridge',
      startCall: '/start-call (POST)',
      callStatus: '/call-status (POST)',
      amdStatus: '/amd-status (POST)',
      mediaStream: '/media-stream (WebSocket)'
    }
  };
});
console.log('Registered GET /');

// Environment variables check endpoint
app.get('/env-check', async (request, reply) => {
  const requiredVars = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_AGENT_ID'
  ];
  
  const optionalVars = [
    'USE_MCP',
    'MCP_URL'
  ];
  
  const missingVars = requiredVars.filter(name => !process.env[name]);
  
  const configStatus = {
    missing: missingVars,
    complete: missingVars.length === 0,
    mode: process.env.USE_MCP === 'true' ? 'mcp' : 'direct',
    mcpUrl: process.env.MCP_URL || 'not configured'
  };
  
  if (!configStatus.complete) {
    return reply.status(500).send(configStatus);
  }
  
  return configStatus;
});
console.log('Registered GET /env-check');

// MCP Bridge connectivity test endpoint
app.get('/test-mcp-bridge', async (request, reply) => {
  const bridgeUrl = process.env.MCP_BRIDGE_URL || 'http://localhost:8001';
  
  try {
    const { createElevenLabsMcpBridgeClient } = await import('./elevenLabsMcpWithBridge.js');
    const client = createElevenLabsMcpBridgeClient({ bridgeUrl });
    
    // Test bridge health
    const isHealthy = await client.checkBridgeHealth();
    
    if (!isHealthy) {
      return reply.status(503).send({ 
        status: 'unhealthy', 
        bridgeUrl,
        message: 'MCP Bridge is not responding or not ready' 
      });
    }
    
    // Get available tools
    const tools = await client.getTools();
    
    return reply.send({ 
      status: 'success', 
      bridgeUrl,
      tools: tools.tools || tools
    });
  } catch (error) {
    return reply.status(500).send({ 
      status: 'error', 
      bridgeUrl,
      message: error.message 
    });
  }
});
console.log('Registered GET /test-mcp-bridge');

// Webhook endpoint for initiating calls
app.post('/start-call', handleCallWebhook);
console.log('Registered POST /start-call');

// Webhook endpoint for call status updates
app.post('/call-status', handleCallStatus);
console.log('Registered POST /call-status');

// Webhook endpoint for AMD status updates
app.post('/amd-status', handleAmdStatus);
console.log('Registered POST /amd-status');

// WebSocket endpoint for media streaming
app.register(async function (fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    handleMediaStreamSocket(connection, req, req.log);
  });
});
console.log('Registered WS /media-stream');

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
  app.log.info(`🚀 Server listening at ${address}`);
  console.log(`🚀 Server listening at ${address}`);
  console.log('Server startup complete');
  
  // Log ElevenLabs configuration
  const bridgeUrl = process.env.MCP_BRIDGE_URL;
  if (bridgeUrl) {
    app.log.info(`🌉 Using ElevenLabs MCP Bridge at ${bridgeUrl}`);
  } else {
    app.log.info('🔌 Using direct ElevenLabs API connection (no MCP Bridge configured)');
  }
});
