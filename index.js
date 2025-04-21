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

// Get a signed URL from ElevenLabs
async function getElevenLabsSignedUrl() {
  return new Promise((resolve, reject) => {
    console.log('📡 Getting signed URL from ElevenLabs...');
    
    // Prepare request data
    const data = JSON.stringify({
      agent_id: ELEVENLABS_AGENT_ID
    });
    
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/convai/conversation/get_signed_url',
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsedResponse = JSON.parse(responseData);
            console.log('✅ Received signed URL from ElevenLabs');
            resolve(parsedResponse);
          } catch (e) {
            console.error(`❌ Error parsing signed URL response: ${e.message}`);
            reject(new Error(`Failed to parse ElevenLabs response: ${e.message}`));
          }
        } else {
          console.error(`❌ Failed to get signed URL: ${res.statusCode}`);
          console.error(`Response: ${responseData}`);
          reject(new Error(`HTTP error ${res.statusCode}: ${responseData}`));
        }
      });
    });
    
    req.on('error', (e) => {
      console.error(`❌ Error getting signed URL: ${e.message}`);
      reject(e);
    });
    
    req.write(data);
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
fastify.get('/twilio-stream', { websocket: true }, async (connection, req) => {
  console.log('🔌 Twilio WebSocket connected');
  console.log(`🌐 Using ElevenLabs Agent ID: ${ELEVENLABS_AGENT_ID}`);
  
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let isClosing = false;
  
  // Get signed URL from ElevenLabs before connecting
  let signedUrlData;
  try {
    signedUrlData = await getElevenLabsSignedUrl();
    console.log(`📝 Received signed URL with signature ID: ${signedUrlData.conversation_signature_id}`);
  } catch (error) {
    console.error(`❌ Failed to get signed URL: ${error.message}`);
    connection.socket.close(1011, 'Failed to get ElevenLabs signed URL');
    return;
  }
  
  // Create ElevenLabs connection
  let elevenWs = null;
  
  const connectToElevenLabs = () => {
    if (isClosing) return;
    
    // Use the signed URL received from ElevenLabs
    const elevenURL = signedUrlData.ws_url;
    console.log(`📡 Connecting to ElevenLabs with signed URL...`);
    
    // Create the WebSocket connection
    elevenWs = new WebSocket(elevenURL);

    elevenWs.on('open', () => {
      console.log('✅ ElevenLabs WebSocket open');
      reconnectAttempts = 0; // Reset reconnect counter on successful connection
      
      // If required, send an initial message (not needed with signed URLs)
      console.log('✅ Connected to ElevenLabs with signed URL');
    });
    
    elevenWs.on('close', (code, reason) => {
      console.log(`🔌 ElevenLabs WebSocket closed: ${code} - ${reason || 'No reason provided'}`);
      
      // Try to reconnect if not intentionally closing and within max attempts
      if (!isClosing && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 Attempting to reconnect to ElevenLabs (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        
        // For reconnect, we need a new signed URL
        getElevenLabsSignedUrl()
          .then(newSignedUrlData => {
            signedUrlData = newSignedUrlData;
            console.log(`📝 Received new signed URL with signature ID: ${signedUrlData.conversation_signature_id}`);
            setTimeout(connectToElevenLabs, 2000 * reconnectAttempts); // Exponential backoff
          })
          .catch(error => {
            console.error(`❌ Failed to get new signed URL for reconnect: ${error.message}`);
          });
      }
    });
    
    elevenWs.on('error', err => {
      console.error(`❌ ElevenLabs WebSocket error: ${err.message}`);
      if (err.message.includes('403')) {
        console.error('This is an authentication error. Check your signed URL implementation.');
      }
    });
    
    // Handle messages from ElevenLabs
    elevenWs.on('message', (data) => {
      try {
        if (connection.socket.readyState === WebSocket.OPEN) {
          console.log(`📥 <- ElevenLabs | Response size: ${data.length} bytes`);
          
          // Check if it's a text message or binary audio
          if (typeof data === 'string' || data instanceof Buffer && data[0] === '{'.charCodeAt(0)) {
            // This might be a JSON message
            try {
              const jsonMsg = typeof data === 'string' ? data : data.toString();
              console.log(`📥 <- ElevenLabs | Text message: ${jsonMsg.substring(0, 100)}...`);
            } catch (e) {
              // Not a text message, that's fine
            }
          }
          
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
        console.log(`📤 -> ElevenLabs | Audio chunk size: ${audioChunk.length} bytes`);
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
});

// Start server
const startServer = async () => {
  try {
    // Try to get a signed URL to verify credentials
    try {
      const signedUrlData = await getElevenLabsSignedUrl();
      console.log('✅ ElevenLabs authentication verified with signed URL');
      console.log(`📝 Signature ID: ${signedUrlData.conversation_signature_id}`);
    } catch (error) {
      console.warn(`⚠️ Could not verify ElevenLabs signed URL: ${error.message}`);
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
