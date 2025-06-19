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
    // Check Python availability first
    console.log('🐍 Checking Python environment...');
    console.log('Python path:', process.env.PATH);
    console.log('Node version:', process.version);
    
    // Try different Python commands
    const pythonCommands = ['python3', 'python', '/usr/bin/python3', '/usr/local/bin/python3'];
    let pythonCmd = null;
    
    for (const cmd of pythonCommands) {
      try {
        const testProcess = spawn(cmd, ['--version'], { stdio: 'pipe' });
        await new Promise((resolve, reject) => {
          testProcess.on('close', (code) => {
            if (code === 0) {
              pythonCmd = cmd;
              console.log(`✅ Found Python: ${cmd}`);
              resolve();
            } else {
              reject();
            }
          });
          testProcess.on('error', reject);
        });
        break;
      } catch (error) {
        console.log(`❌ Python command failed: ${cmd}`);
        continue;
      }
    }
    
    if (!pythonCmd) {
      throw new Error('No Python interpreter found');
    }
    
    // Test if elevenlabs-mcp package is available
    console.log('📦 Testing elevenlabs-mcp package...');
    try {
      const testImport = spawn(pythonCmd, ['-c', 'import elevenlabs_mcp; print("✅ elevenlabs-mcp available")'], { stdio: 'pipe' });
      await new Promise((resolve, reject) => {
        let output = '';
        testImport.stdout.on('data', (data) => {
          output += data.toString();
        });
        testImport.on('close', (code) => {
          if (code === 0) {
            console.log('Package test output:', output.trim());
            resolve();
          } else {
            reject(new Error(`elevenlabs-mcp import failed with code ${code}`));
          }
        });
        testImport.on('error', reject);
      });
    } catch (error) {
      console.error('❌ elevenlabs-mcp package not available:', error.message);
      throw new Error('elevenlabs-mcp package not installed or not accessible');
    }

    // Spawn the ElevenLabs MCP server
    console.log(`🚀 Starting MCP server with: ${pythonCmd} -m elevenlabs_mcp`);
    this.mcpProcess = spawn(pythonCmd, ['-m', 'elevenlabs_mcp'], {
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        PYTHONPATH: process.env.PYTHONPATH || '',
        PATH: process.env.PATH
      },
      stdio: ['pipe', 'pipe', 'pipe'] // Capture stderr too
    });

    // Handle MCP server responses
    this.mcpProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(line => line.trim());
      console.log('📥 MCP stdout:', lines);
      
      for (const line of lines) {
        try {
          const response = JSON.parse(line);
          this.handleMCPResponse(response);
        } catch (error) {
          console.log('📝 MCP output (non-JSON):', line);
        }
      }
    });
    
    // Handle stderr
    this.mcpProcess.stderr.on('data', (data) => {
      console.error('📥 MCP stderr:', data.toString());
    });

    this.mcpProcess.on('error', (error) => {
      console.error('❌ MCP process error:', error);
      throw error;
    });
    
    this.mcpProcess.on('close', (code, signal) => {
      console.log(`📤 MCP process closed with code ${code}, signal ${signal}`);
      this.isReady = false;
    });

    // Wait a bit for MCP server to fully start
    console.log('⏳ Waiting for MCP server to initialize...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Initialize MCP connection
    console.log('🤝 Initializing MCP connection...');
    try {
      const initResponse = await this.sendMCPRequest({
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
      
      console.log('✅ MCP initialization response:', initResponse);
      
      // Send initialized notification
      await this.sendMCPRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      });
      
      console.log('✅ MCP initialized notification sent');
      
    } catch (error) {
      console.error('❌ MCP initialization failed:', error);
      throw error;
    }

    this.isReady = true;
    console.log('✅ MCP Bridge ready and initialized');
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
    console.error('💡 Tips for fixing:');
    console.error('  1. Ensure Python 3.8+ is available');
    console.error('  2. Install: pip3 install elevenlabs-mcp');
    console.error('  3. Set ELEVENLABS_API_KEY environment variable');
    console.error('  4. Check build logs for Python installation errors');
    
    // Don't exit - let the HTTP server stay up for debugging
    console.log('🔧 MCP Bridge will be unavailable, but HTTP endpoints remain active for debugging');
  }
}); 