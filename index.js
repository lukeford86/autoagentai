// index.js
require('dotenv').config();
const fastify = require('fastify')({ logger: true });
const WebSocket = require('ws');
const twilio = require('twilio');
const https = require('https');

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

// Verify ElevenLabs credentials
async function verifyElevenLabsCredentials() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/user',
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 200) {
        console.log('✅ ElevenLabs API key verified');
        resolve(true);
      } else {
        console.error(`❌ ElevenLabs API key verification failed: ${res.statusCode}`);
        resolve(false);
      }
    });

    req.on('error', (e) => {
      console.error(`❌ ElevenLabs API key verification error: ${e.message}`);
      resolve(false);
    });

    req.end();
  });
}

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

// Add route handlers
fastify.get('/twiml', handleTwiML);
fastify.post('/twiml', handleTwiML);

// Health check endpoint
fastify.get('/health', async (req, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Root route with basic info
fastify.get('/', async (req, reply) => {
  return { 
    service: 'Auto Agent AI Bridge',
    status: 'running',
    endpoints: ['/health', '/twiml', '/outbound-call']
  };
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
fastify.post('/call-status', async (req, reply) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`📊 Call ${CallSid} status: ${CallStatus}`);
  return { received: true };
});

// WebSocket: Twilio <-> ElevenLabs
fastify.get('/twilio-stream', { websocket: true }, (connection, req) => {
  const agentId = ELEVENLABS_AGENT_ID;
  
  // Use the correct format for ElevenLabs Convai API
  const elevenURL = `wss://api.elevenlabs.io/v1/text-to-speech/${agentId}/stream-input?optimize_streaming_latency=0`;
  
  console.log('🔌 Twilio WebSocket connected');
  console.log(`🌐 Using ElevenLabs Agent ID: ${agentId}`);
  console.log(`📡 ElevenLabs URL: ${elevenURL}`);
  
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let isClosing = false;
  
  // Create ElevenLabs connection
  let elevenWs = null;
  
  const connectToElevenLabs = () => {
    if (isClosing) return;
    
    console.log(`📡 Connecting to ElevenLabs...`);
    
    // Additional headers for ElevenLabs authentication
    const headers = {
      'xi-api-key': ELEVENLABS_API_KEY,
      'User-Agent': 'ElevenLabs-TwilioConnector/1.0'
    };
    
    // Create the WebSocket connection
    elevenWs = new WebSocket(elevenURL, { headers });

    elevenWs.on('open', () => {
      console.log('✅ ElevenLabs WebSocket open');
      
      // If required, send an initial config message
      const configMessage = JSON.stringify({
        text: "",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        },
        xi_api_key: ELEVENLABS_API_KEY
      });
      
      // Only send if WebSocket is open
      if (elevenWs.readyState === WebSocket.OPEN) {
        console.log('📤 Sending initial config to ElevenLabs');
        elevenWs.send(configMessage);
      }
      
      reconnectAttempts = 0; // Reset reconnect counter on successful connection
    });
    
    elevenWs.on('close', (code, reason) => {
      console.log(`🔌 ElevenLabs WebSocket closed: ${code} - ${reason || 'No reason provided'}`);
      
      // Try to reconnect if not intentionally closing and within max attempts
      if (!isClosing && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Attempting to reconnect to ElevenLabs (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(connectToElevenLabs, 2000 * reconnectAttempts); // Exponential backoff
      }
    });
    
    elevenWs.on('error', err => {
      console.error(`❌ ElevenLabs WebSocket error: ${err.message}`);
      console.error('Error details:', err);
    });
    
    // Handle messages from ElevenLabs
    elevenWs.on('message', (data) => {
      try {
        if (connection.socket.readyState === WebSocket.OPEN) {
          console.log(`📥 <- ElevenLabs | Received data of type: ${typeof data}`);
          
          // Check if data is binary audio or text JSON
          if (data instanceof Buffer) {
            console.log(`📥 <- ElevenLabs | Audio response size: ${data.length} bytes`);
            connection.socket.send(data);
          } else {
            // If text, try to parse as JSON
            const textData = data.toString();
            console.log(`📥 <- ElevenLabs | Text response: ${textData.substring(0, 100)}...`);
            
            // Still forward to Twilio in case it's needed
            connection.socket.send(data);
          }
        }
      } catch (error) {
        console.error(`❌ Error processing ElevenLabs message: ${error.message}`);
      }
    });
  };
  
  // Connect to ElevenLabs
  connectToElevenLabs();
  
  // Handle messages from Twilio
  connection.socket.on('message', (audioChunk) => {
    try {
      if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
        console.log(`📤 -> ElevenLabs | Sending audio chunk: ${audioChunk.length} bytes`);
        elevenWs.send(audioChunk);
      } else {
        console.warn('⚠️ ElevenLabs WebSocket not ready, dropping audio chunk');
      }
    } catch (error) {
      console.error(`❌ Error sending audio to ElevenLabs: ${error.message}`);
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
const startServer = async () => {
  try {
    // Verify ElevenLabs credentials before starting
    const credentialsValid = await verifyElevenLabsCredentials();
    if (!credentialsValid) {
      console.warn('⚠️ ElevenLabs credentials could not be verified. Server will start but calls may fail.');
    }
    
    const address = await fastify.listen({ port: Number(PORT), host: HOST });
    console.log(`🚀 Server listening at ${address}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🤖 Using ElevenLabs Agent ID: ${ELEVENLABS_AGENT_ID}`);
  } catch (err) {
    console.error(`❌ Server failed to start: ${err.message}`);
    process.exit(1);
  }
};

startServer();

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
