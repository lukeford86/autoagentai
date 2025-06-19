// mcp-bridge-server.js
import { spawn } from 'child_process';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';

const app = Fastify({ logger: true });
app.register(fastifyCors);

class MCPBridge {
  constructor() {
    this.mcpProcess = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.isReady = false;
  }

  async start() {
    // Spawn the ElevenLabs MCP server
    this.mcpProcess = spawn('python', ['-m', 'elevenlabs_mcp'], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY
      },
      stdio: ['pipe', 'pipe', 'inherit']
    });

    // Handle MCP server responses
    this.mcpProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          this.handleMCPResponse(response);
        } catch (error) {
          console.error('Failed to parse MCP response:', error);
        }
      }
    });

    this.mcpProcess.on('error', (error) => {
      console.error('MCP process error:', error);
    });

    // Initialize MCP connection
    await this.sendMCPRequest({
      jsonrpc: '2.0',
      id: this.getNextId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        clientInfo: {
          name: 'twilio-bridge',
          version: '1.0.0'
        }
      }
    });

    this.isReady = true;
    console.log('MCP Bridge ready');
  }

  getNextId() {
    return ++this.requestId;
  }

  async sendMCPRequest(request) {
    return new Promise((resolve, reject) => {
      if (!this.mcpProcess) {
        reject(new Error('MCP process not started'));
        return;
      }

      const id = request.id || this.getNextId();
      request.id = id;

      this.pendingRequests.set(id, { resolve, reject });
      
      const message = JSON.stringify(request) + '\n';
      this.mcpProcess.stdin.write(message);

      // Set timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('MCP request timeout'));
        }
      }, 30000); // 30 second timeout
    });
  }

  handleMCPResponse(response) {
    if (response.id && this.pendingRequests.has(response.id)) {
      const { resolve, reject } = this.pendingRequests.get(response.id);
      this.pendingRequests.delete(response.id);

      if (response.error) {
        reject(new Error(response.error.message || 'MCP error'));
      } else {
        resolve(response.result);
      }
    }
  }

  // Get available MCP tools
  async getTools() {
    if (!this.isReady) throw new Error('MCP Bridge not ready');
    
    return await this.sendMCPRequest({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {}
    });
  }

  // Call an MCP tool
  async callTool(name, arguments_) {
    if (!this.isReady) throw new Error('MCP Bridge not ready');
    
    return await this.sendMCPRequest({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: arguments_
      }
    });
  }

  async stop() {
    if (this.mcpProcess) {
      this.mcpProcess.kill();
      this.mcpProcess = null;
    }
    this.isReady = false;
  }
}

const mcpBridge = new MCPBridge();

// HTTP endpoints that translate to MCP calls
app.get('/health', async (request, reply) => {
  return { 
    status: mcpBridge.isReady ? 'ready' : 'not_ready',
    mcp_process: !!mcpBridge.mcpProcess
  };
});

app.get('/tools', async (request, reply) => {
  try {
    const tools = await mcpBridge.getTools();
    return tools;
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

app.post('/call-tool', async (request, reply) => {
  try {
    const { name, arguments: args } = request.body;
    const result = await mcpBridge.callTool(name, args);
    return result;
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// ElevenLabs specific endpoints
app.post('/create-voice-agent', async (request, reply) => {
  try {
    const { systemPrompt, firstMessage, voiceSettings } = request.body;
    
    const result = await mcpBridge.callTool('create_conversational_agent', {
      name: 'TwilioAgent',
      system_prompt: systemPrompt,
      first_message: firstMessage,
      voice_settings: voiceSettings
    });
    
    return result;
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

app.post('/text-to-speech', async (request, reply) => {
  try {
    const { text, voiceId, outputPath } = request.body;
    
    const result = await mcpBridge.callTool('text_to_speech', {
      text,
      voice_id: voiceId,
      output_path: outputPath || './output.mp3'
    });
    
    return result;
  } catch (error) {
    return reply.status(500).send({ error: error.message });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down MCP Bridge...');
  await mcpBridge.stop();
  process.exit(0);
});

const PORT = process.env.MCP_BRIDGE_PORT || 8001;
app.listen({ port: PORT, host: '0.0.0.0' }, async (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  
  console.log(`🌉 MCP Bridge listening at ${address}`);
  
  try {
    await mcpBridge.start();
    console.log('✅ MCP Bridge started successfully');
  } catch (error) {
    console.error('❌ Failed to start MCP Bridge:', error);
    process.exit(1);
  }
}); 