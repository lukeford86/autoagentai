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
  SERVER_DOMAIN,
  PORT = process.env.PORT || 3000,
  HOST = '0.0.0.0'
} = process.env;

// Validate required env vars
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('❌ Missing Twilio environment variables.');
  process.exit(1);
}

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('❌ Missing ElevenLabs environment variables.');
  process.exit(1);
}

// Initialize Twilio client
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Twilio request validator middleware
const validateTwilioRequest = (request, reply, done) => {
  if (process.env.NODE_ENV === 'production') {
    const twilioSignature = request.headers['x-twilio-signature'];
    const url = `https://${SERVER_DOMAIN}${request.url}`;
    
    if (!twilioSignature) {
      console.warn('⚠️ Missing Twilio signature');
      return done();
    }
    
    const requestValid = twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      twilioSignature,
      url,
      request.body
    );
    
    if (!requestValid) {
      console.error('❌ Invalid Twilio request signature');
      return reply.code(403).send({ error: 'Invalid signature' });
    }
  }
  done();
};

// Register Fastify plugins
fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'), {
  options: {
    maxPayload: 1048576, // 1MB max payload
    pingInterval: 30000, // Keep connections alive
  }
});

// Helper for generating proper URLs
function getServerUrl(request) {
  // Prefer the configured SERVER_DOMAIN if available
  if (SERVER_DOMAIN) {
    return SERVER_DOMAIN;
  }
  
  // Otherwise use the request hostname
  const isLocalhost = request.hostname.includes('localhost');
  return isLocalhost ? `localhost:${PORT}` : request.hostname;
}

// Serve TwiML for Twilio
async function handleTwiML(req, reply) {
  const hostname = getServerUrl(req);
  const protocol = hostname.includes('localhost') ? 'ws' : 'wss';
  const streamUrl = `${protocol}://${hostname}/twilio-stream`;
  
  console.log(`🧭 Generated stream URL: ${streamUrl}`);

  // Enhanced TwiML with more stability options
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream url="${streamUrl}" track="inbound_track" content-type="audio/x-mulaw;rate=8000" />
  </Start>
  <Pause length="300" />
</Response>`;

  console.log('📤 Sending TwiML response');
  reply.type('text/xml').send(xml);
}

// Add pre-handler for Twilio request validation
const twilioRouteConfig = {
  preHandler: validateTwilioRequest
};

fastify.get('/twiml', twilioRouteConfig, handleTwiML);
fastify.post('/twiml', twilioRouteConfig, handleTwiML);

// Health check endpoint
fastify.get('/health', async (req, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Outbound call trigger
fastify.post('/outbound-call', async (req, reply) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return reply.status(400).send({ error: 'Phone number is required' });
  }
  
  console.log(`📞 Outbound call requested to ${phoneNumber}`);

  try {
    const hostname = getServerUrl(req);
    const protocol = hostname.includes('localhost') ? 'http' : 'https';
    const twimlUrl = `${protocol}://${hostname}/twiml`;
    console.log(`📡 TwiML URL: ${twimlUrl}`);

    const call = await client.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: twimlUrl,
      statusCallback: `${protocol}://${hostname}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    
    console.log(`✅ Twilio call initiated. SID: ${call.sid}`);
    return { status: 'ok', sid: call.sid };
  } catch (err) {
    console.error(`❌ Failed to create Twilio call: ${err.message}`);
    reply.status(500).send({ error: err.message });
  }
});

// Call status webhook
fastify.post('/call-status', twilioRouteConfig, async (req, reply) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📊 Call ${CallSid} status: ${CallStatus}`);
  return { received: true };
});

// WebSocket: Twilio <-> ElevenLabs
fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  // IMPORTANT FIX: Use ELEVENLABS_AGENT_ID directly instead of from query params
  const agentId = ELEVENLABS_AGENT_ID;
  const elevenURL = `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${agentId}`;

  console.log('🔌 Twilio WebSocket connected');
  console.log(`🌐 Using ElevenLabs Agent ID: ${agentId}`);
  
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let isClosing = false;
  
  // Create ElevenLabs connection
  let elevenWs = null;
  
  const connectToElevenLabs = () => {
    if (isClosing) return;
    
    console.log(`📡 Connecting to ElevenLabs at ${elevenURL}`);
    
    elevenWs = new WebSocket(elevenURL, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });

    elevenWs.on('open', () => {
      console.log('✅ ElevenLabs WebSocket open');
      reconnectAttempts = 0; // Reset reconnect counter on successful connection
      
      // Send a ping every 30 seconds to keep the connection alive
      const pingInterval = setInterval(() => {
        if (elevenWs.readyState === WebSocket.OPEN) {
          console.log('📡 Sending ping to ElevenLabs');
          elevenWs.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 30000);
      
      // Clear interval when connection closes
      elevenWs.on('close', () => clearInterval(pingInterval));
    });
    
    elevenWs.on('close', (code, reason) => {
      console.log(`🔌 ElevenLabs WebSocket closed: ${code} - ${reason}`);
      
      // Try to reconnect if not intentionally closing and within max attempts
      if (!isClosing && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Attempting to reconnect to ElevenLabs (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(connectToElevenLabs, 2000 * reconnectAttempts); // Exponential backoff
      }
    });
    
    elevenWs.on('error', err => {
      console.error(`❌ ElevenLabs WebSocket error: ${err.message}`);
    });
    
    // Handle messages from ElevenLabs
    elevenWs.on('message', (aiAudio) => {
      if (connection.socket.readyState === WebSocket.OPEN) {
        console.log(`📥 <- ElevenLabs | Response size: ${aiAudio.length} bytes`);
        connection.socket.send(aiAudio);
      }
    });
  };
  
  // Connect to ElevenLabs
  connectToElevenLabs();
  
  // Handle messages from Twilio
  connection.socket.on('message', (audioChunk) => {
    if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
      console.log(`📤 -> ElevenLabs | Chunk size: ${audioChunk.length} bytes`);
      elevenWs.send(audioChunk);
    } else {
      console.warn('⚠️ ElevenLabs WebSocket not ready, dropping audio chunk');
    }
  });
  
  // Handle Twilio connection close
  connection.socket.on('close', () => {
    console.log('🔌 Twilio WebSocket closed');
    isClosing = true; // Mark as intentionally closing
    if (elevenWs) {
      elevenWs.close();
    }
  });
  
  // Handle Twilio connection errors
  connection.socket.on('error', (err) => {
    console.error(`❌ Twilio WebSocket error: ${err.message}`);
  });
  
  // Handle pings to keep connection alive
  connection.socket.on('ping', () => {
    console.log('📡 Received ping from Twilio');
    connection.socket.pong();
  });
});

// Start server
fastify.listen({ port: Number(PORT), host: HOST }, (err, address) => {
  if (err) {
    console.error(`❌ Server failed to start: ${err.message}`);
    process.exit(1);
  }
  console.log(`🚀 Server listening at ${address}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🤖 Using ElevenLabs Agent ID: ${ELEVENLABS_AGENT_ID}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('🛑 Shutting down server...');
  fastify.close(() => {
    console.log('✅ Server shutdown complete');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
