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

// Verify ElevenLabs credentials
function verifyElevenLabsCredentials() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/user/subscription',
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const subscription = JSON.parse(data);
            console.log('✅ ElevenLabs API key valid');
            console.log(`📊 Subscription tier: ${subscription.tier}`);
            console.log(`📊 Character count: ${subscription.character_count} / ${subscription.character_limit}`);
            resolve(true);
          } catch (e) {
            console.error(`❌ Error parsing ElevenLabs response: ${e.message}`);
            resolve(false);
          }
        } else {
          console.error(`❌ ElevenLabs API key validation failed: ${res.statusCode}`);
          console.error(`Response: ${data}`);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.error(`❌ Error verifying ElevenLabs credentials: ${e.message}`);
      resolve(false);
    });

    req.end();
  });
}

// Check if agent exists in ElevenLabs
function verifyElevenLabsAgent() {
  return new Promise((resolve, reject) => {
    // First try to list all agents
    const options = {
      hostname: 'api.elevenlabs.io',
      port: 443,
      path: '/v1/convai/agents',
      method: 'GET',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const response = JSON.parse(data);
            console.log(`📊 Found ${response.agents.length} agents in ElevenLabs account`);
            
            // Search for our agent
            const agent = response.agents.find(a => a.agent_id === ELEVENLABS_AGENT_ID);
            
            if (agent) {
              console.log(`✅ Found agent "${agent.name}" with ID: ${agent.agent_id}`);
              resolve(agent);
            } else {
              console.error(`❌ Could not find agent with ID: ${ELEVENLABS_AGENT_ID}`);
              
              // Log available agents to help debug
              response.agents.forEach(a => {
                console.log(`Available agent: "${a.name}" - ID: ${a.agent_id}`);
              });
              
              resolve(null);
            }
          } catch (e) {
            console.error(`❌ Error parsing ElevenLabs agents: ${e.message}`);
            resolve(null);
          }
        } else {
          console.error(`❌ Failed to fetch ElevenLabs agents: ${res.statusCode}`);
          console.error(`Response: ${data}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error(`❌ Error checking ElevenLabs agent: ${e.message}`);
      resolve(null);
    });

    req.end();
  });
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
  
  // This is the correct URL format for ElevenLabs Convai
  const elevenURL = `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${agentId}`;
  
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
    
    // Prepare WebSocket options with authorization header
    const wsOptions = {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      },
      // Enable additional debugging
      perMessageDeflate: false
    };
    
    console.log(`🔑 Using API key: ${ELEVENLABS_API_KEY.substring(0, 3)}...${ELEVENLABS_API_KEY.slice(-3)}`);
    
    // Create the WebSocket connection
    elevenWs = new WebSocket(elevenURL, wsOptions);

    elevenWs.on('open', () => {
      console.log('✅ ElevenLabs WebSocket open');
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
      if (err.message.includes('403')) {
        console.error('This is an authentication error. Your API key may not have access to this agent or the Convai API.');
      }
    });
    
    // Handle messages from ElevenLabs
    elevenWs.on('message', (data) => {
      try {
        if (connection.socket.readyState === WebSocket.OPEN) {
          console.log(`📥 <- ElevenLabs | Response size: ${data.length} bytes`);
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
    console.log('🔍 Verifying ElevenLabs credentials...');
    const credentialsValid = await verifyElevenLabsCredentials();
    
    if (!credentialsValid) {
      console.warn('⚠️ ElevenLabs credentials could not be verified. Server will start but calls may fail.');
    } else {
      console.log('🔍 Checking ElevenLabs agent...');
      const agent = await verifyElevenLabsAgent();
      
      if (!agent) {
        console.warn('⚠️ ElevenLabs agent not found. Please verify your agent ID.');
      }
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
