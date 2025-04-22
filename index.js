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
    <Stream url="${streamUrl}" />
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
  console.log('🔌 Twilio WebSocket connected');
  
  // The WebSocket URL for ElevenLabs Conversational AI - EXACTLY as specified in docs
  const elevenURL = `wss://api.elevenlabs.io/v1/conversation`;
  
  console.log(`🌐 Using ElevenLabs Agent ID: ${ELEVENLABS_AGENT_ID}`);
  console.log(`📡 ElevenLabs URL: ${elevenURL}`);
  
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let isClosing = false;
  
  // Create ElevenLabs connection
  let elevenWs = null;
  
  const connectToElevenLabs = () => {
    if (isClosing) return;
    
    console.log(`📡 Connecting to ElevenLabs...`);
    
    // Create the WebSocket connection with the API key in headers
    elevenWs = new WebSocket(elevenURL, {
      headers: { 
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });

    elevenWs.on('open', () => {
      console.log('✅ ElevenLabs WebSocket open');
      
      // Send the agent ID message immediately after connection
      // This is REQUIRED per the WebSocket API docs
      try {
        const initMessage = JSON.stringify({
          type: "agent",
          agent_id: ELEVENLABS_AGENT_ID,
          session_id: `twilio-call-${Date.now()}`
        });
        console.log(`📤 Sending agent initialization: ${initMessage}`);
        elevenWs.send(initMessage);
      } catch (error) {
        console.error(`❌ Error sending agent initialization: ${error.message}`);
      }
      
      reconnectAttempts = 0; // Reset reconnect counter
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
      if (err.message.includes('403')) {
        console.error('This is an authentication error. Please verify your API key and agent settings.');
        console.error('Make sure your subscription plan includes Conversational AI capabilities.');
      }
    });
    
    // Handle messages from ElevenLabs
    elevenWs.on('message', (data) => {
      try {
        if (connection.socket.readyState === WebSocket.OPEN) {
          // Try to parse as JSON first to see if it's a control message
          try {
            const jsonData = JSON.parse(data.toString());
            console.log(`📥 <- ElevenLabs | JSON message:`, jsonData);
            
            // If it's not audio data, no need to forward to Twilio
            if (jsonData.type !== 'audio') {
              return;
            }
          } catch (e) {
            // Not JSON, assume it's binary audio data
            console.log(`📥 <- ElevenLabs | Binary audio data: ${data.length} bytes`);
          }
          
          // Forward the data to Twilio
          connection.socket.send(data);
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
        // Check if it's a binary audio chunk or a JSON message
        let isJson = false;
        try {
          // Check if it starts with a bracket (JSON)
          if (audioChunk[0] === '{'.charCodeAt(0)) {
            isJson = true;
            const jsonMsg = JSON.parse(audioChunk.toString());
            console.log(`📤 -> ElevenLabs | JSON message from Twilio:`, jsonMsg);
          }
        } catch (e) {
          // Not JSON, that's fine
        }
        
        if (!isJson) {
          // Package the binary audio data in the correct format
          const audioMessage = {
            type: "audio",
            data: audioChunk.toString('base64')
          };
          
          console.log(`📤 -> ElevenLabs | Audio data: ${audioChunk.length} bytes`);
          elevenWs.send(JSON.stringify(audioMessage));
        } else {
          // It's already JSON, send as is
          elevenWs.send(audioChunk);
        }
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
