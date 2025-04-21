// test-elevenlabs.js
// A simple test script to verify ElevenLabs Convai connectivity

require('dotenv').config();
const WebSocket = require('ws');
const https = require('https');

// Get API key and agent ID from environment variables
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Error: ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID environment variables are required');
  process.exit(1);
}

console.log(`Testing ElevenLabs Convai connection for agent: ${ELEVENLABS_AGENT_ID}`);
console.log(`API Key: ${ELEVENLABS_API_KEY.substring(0, 3)}...${ELEVENLABS_API_KEY.slice(-3)}`);

// 1. First check account subscription
console.log('\n1. Testing API key validity by checking subscription...');
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
        console.log('✅ ElevenLabs API key is valid');
        console.log(`Subscription tier: ${subscription.tier}`);
        console.log(`Character count: ${subscription.character_count} / ${subscription.character_limit}`);
        
        // After confirming API key works, check agents
        checkAgents();
      } catch (e) {
        console.error(`❌ Error parsing ElevenLabs response: ${e.message}`);
      }
    } else {
      console.error(`❌ ElevenLabs API key validation failed: ${res.statusCode}`);
      console.error(`Response: ${data}`);
    }
  });
});

req.on('error', (e) => {
  console.error(`❌ Error verifying ElevenLabs credentials: ${e.message}`);
});

req.end();

// 2. Check available agents
function checkAgents() {
  console.log('\n2. Checking available agents...');
  
  const agentOptions = {
    hostname: 'api.elevenlabs.io',
    port: 443,
    path: '/v1/convai/agents',
    method: 'GET',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json'
    }
  };

  const agentReq = https.request(agentOptions, (res) => {
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const response = JSON.parse(data);
          console.log(`Found ${response.agents?.length || 0} agents in ElevenLabs account`);
          
          if (response.agents && response.agents.length > 0) {
            // Check if our agent exists
            const agent = response.agents.find(a => a.agent_id === ELEVENLABS_AGENT_ID);
            
            if (agent) {
              console.log(`✅ Found agent "${agent.name}" with ID: ${agent.agent_id}`);
              console.log(`Agent status: ${agent.status}`);
              
              // After confirming agent exists, test WebSocket connection
              testWebSocket();
            } else {
              console.error(`❌ Could not find agent with ID: ${ELEVENLABS_AGENT_ID}`);
              console.log('\nAvailable agents:');
              response.agents.forEach(a => {
                console.log(`- "${a.name}" (ID: ${a.agent_id}, Status: ${a.status})`);
              });
            }
          } else {
            console.error('❌ No agents found in your ElevenLabs account');
          }
        } catch (e) {
          console.error(`❌ Error parsing ElevenLabs agents: ${e.message}`);
          console.error(`Raw response: ${data}`);
        }
      } else {
        console.error(`❌ Failed to fetch ElevenLabs agents: ${res.statusCode}`);
        console.error(`Response: ${data}`);
      }
    });
  });

  agentReq.on('error', (e) => {
    console.error(`❌ Error checking ElevenLabs agents: ${e.message}`);
  });

  agentReq.end();
}

// 3. Test WebSocket connection
function testWebSocket() {
  console.log('\n3. Testing WebSocket connection...');
  
  const url = `wss://api.elevenlabs.io/v1/convai/ws?agent_id=${ELEVENLABS_AGENT_ID}`;
  console.log(`Connecting to: ${url}`);
  
  const ws = new WebSocket(url, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY
    }
  });
  
  ws.on('open', () => {
    console.log('✅ WebSocket connection established successfully!');
    
    // Send a test message
    const testMessage = {
      type: 'text',
      text: 'Hello agent, this is a test message'
    };
    
    try {
      ws.send(JSON.stringify(testMessage));
      console.log('✅ Test message sent');
      
      // Close after 5 seconds
      setTimeout(() => {
        console.log('Closing connection after 5 second test...');
        ws.close();
        process.exit(0);
      }, 5000);
    } catch (e) {
      console.error(`❌ Error sending test message: ${e.message}`);
    }
  });
  
  ws.on('message', (data) => {
    console.log(`✅ Received response from ElevenLabs agent: ${data.length} bytes`);
    try {
      // Check if it's a text message
      const textData = data.toString();
      if (textData.startsWith('{')) {
        console.log('Response (JSON):', textData);
      } else {
        console.log('Response (likely binary audio):', `${data.length} bytes`);
      }
    } catch (e) {
      console.log('Response is binary data');
    }
  });
  
  ws.on('error', (err) => {
    console.error(`❌ WebSocket connection error: ${err.message}`);
    if (err.message.includes('403')) {
      console.error('This is an authentication error. Your API key may not have access to this agent or the Convai API.');
      console.error('Possible reasons:');
      console.error('1. Your subscription tier does not include Conversational AI access');
      console.error('2. The agent ID is incorrect or not available');
      console.error('3. The agent is not fully deployed or activated');
      console.error('4. Your API key does not have the required permissions');
    }
  });
  
  ws.on('close', (code, reason) => {
    console.log(`WebSocket closed with code ${code}: ${reason || 'No reason provided'}`);
  });
}
