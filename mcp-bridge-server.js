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
      const testImport = spawn(pythonCmd, ['-c', 'import elevenlabs_mcp; print("✅ elevenlabs-mcp available"); import sys; print(f"Python version: {sys.version}")'], { stdio: 'pipe' });
      await new Promise((resolve, reject) => {
        let output = '';
        let errorOutput = '';
        
        testImport.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        testImport.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
        
        testImport.on('close', (code) => {
          console.log('📦 Package test output:', output.trim());
          if (errorOutput) {
            console.log('📦 Package test errors:', errorOutput.trim());
          }
          
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`elevenlabs-mcp import failed with code ${code}. Error: ${errorOutput}`));
          }
        });
        
        testImport.on('error', reject);
        
        // Add timeout for the test
        setTimeout(() => {
          testImport.kill();
          reject(new Error('Package test timeout'));
        }, 10000);
      });
    } catch (error) {
      console.error('❌ elevenlabs-mcp package not available:', error.message);
      throw new Error('elevenlabs-mcp package not installed or not accessible');
    }

    // Test if MCP server can start at all
    console.log('🧪 Testing MCP server startup...');
    try {
      const testMcp = spawn(pythonCmd, ['-m', 'elevenlabs_mcp', '--help'], { 
        stdio: 'pipe',
        timeout: 5000 
      });
      
      await new Promise((resolve, reject) => {
        let output = '';
        let errorOutput = '';
        
        testMcp.stdout.on('data', (data) => output += data.toString());
        testMcp.stderr.on('data', (data) => errorOutput += data.toString());
        
        testMcp.on('close', (code) => {
          console.log('🧪 MCP server test output:', { output: output.slice(0, 200), error: errorOutput.slice(0, 200) });
          resolve(); // Don't fail if help command returns non-zero
        });
        
        testMcp.on('error', (error) => {
          console.log('🧪 MCP server test error:', error.message);
          resolve(); // Continue anyway
        });
        
        setTimeout(() => {
          testMcp.kill();
          resolve();
        }, 5000);
      });
    } catch (error) {
      console.log('🧪 MCP server test failed, continuing anyway:', error.message);
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

    // Wait for MCP server to fully start and show some output
    console.log('⏳ Waiting for MCP server to initialize...');
    
    // Wait for the process to output something or timeout
    let processReady = false;
    const readyTimeout = setTimeout(() => {
      if (!processReady) {
        console.log('⚠️ MCP process timeout - proceeding with initialization attempt');
      }
    }, 5000);
    
    // Listen for any output that indicates the server is ready
    const readyPromise = new Promise((resolve) => {
      const checkReady = () => {
        if (!processReady) {
          processReady = true;
          clearTimeout(readyTimeout);
          console.log('📡 MCP process appears to be outputting data');
          resolve();
        }
      };
      
      // Consider the server ready after any stdout output or after 3 seconds
      this.mcpProcess.stdout.once('data', checkReady);
      setTimeout(checkReady, 3000); // Fallback timeout
    });
    
    await readyPromise;

    // Initialize MCP connection with retries
    console.log('🤝 Initializing MCP connection...');
    let initSuccess = false;
    let lastError = null;
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🔄 MCP initialization attempt ${attempt}/3`);
        
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
        initSuccess = true;
        break;
        
      } catch (error) {
        lastError = error;
        console.error(`❌ MCP initialization attempt ${attempt} failed:`, error.message);
        
        if (attempt < 3) {
          console.log(`⏳ Waiting 2 seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (!initSuccess) {
      console.error('❌ All MCP initialization attempts failed');
      throw lastError || new Error('MCP initialization failed after 3 attempts');
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
          reject(new Error(`MCP request timeout after 15s. Request: ${JSON.stringify(request)}`));
        }
      }, 15000); // 15 second timeout
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