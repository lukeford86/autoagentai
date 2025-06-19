import https from 'https';
import http from 'http';

/**
 * Client for interacting with ElevenLabs via MCP Bridge
 */
export class ElevenLabsMcpBridgeClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.agentId = options.agentId || process.env.ELEVENLABS_AGENT_ID;
    this.bridgeUrl = options.bridgeUrl || process.env.MCP_BRIDGE_URL || 'http://localhost:8001';
    this.timeout = options.timeout || 30000;
    
    if (!this.apiKey) {
      throw new Error('ELEVENLABS_API_KEY is required');
    }
    
    if (!this.agentId) {
      throw new Error('ELEVENLABS_AGENT_ID is required');
    }
    
    // Parse bridge URL
    try {
      const url = new URL(this.bridgeUrl);
      this.bridgeProtocol = url.protocol.replace(':', '');
      this.bridgeHost = url.hostname;
      this.bridgePort = url.port ? parseInt(url.port) : (this.bridgeProtocol === 'https' ? 443 : 80);
    } catch (error) {
      console.error('Invalid MCP Bridge URL:', error);
      throw new Error('Invalid MCP Bridge URL');
    }
  }

  /**
   * Make a request to the MCP Bridge
   */
  async requestBridge(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const requestData = body ? JSON.stringify(body) : null;
      
      const requestOptions = {
        hostname: this.bridgeHost,
        port: this.bridgePort,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(requestData && { 'Content-Length': Buffer.byteLength(requestData) })
        },
        timeout: this.timeout
      };

      console.log('🌉 MCP Bridge Request:', {
        url: `${this.bridgeProtocol}://${this.bridgeHost}:${this.bridgePort}${path}`,
        method,
        body
      });

      const requester = this.bridgeProtocol === 'https' ? https : http;
      
      const req = requester.request(requestOptions, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          console.log('📥 MCP Bridge Response:', {
            statusCode: res.statusCode,
            data: responseData
          });
          
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsedData = responseData ? JSON.parse(responseData) : {};
              resolve(parsedData);
            } catch (error) {
              reject(new Error(`Failed to parse response: ${error.message}`));
            }
          } else {
            reject(new Error(`Bridge request failed with status ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        console.error('❌ MCP Bridge Request Error:', error);
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        console.error('⏰ MCP Bridge Request Timeout');
        req.destroy();
        reject(new Error('Request timed out'));
      });

      if (requestData) {
        req.write(requestData);
      }
      
      req.end();
    });
  }

  /**
   * Check if bridge is healthy
   */
  async checkBridgeHealth() {
    try {
      const health = await this.requestBridge('/health');
      return health.status === 'ready';
    } catch (error) {
      console.error('Bridge health check failed:', error);
      return false;
    }
  }

  /**
   * Get available MCP tools
   */
  async getTools() {
    return await this.requestBridge('/tools');
  }

  /**
   * Create a conversational agent via MCP
   */
  async createVoiceAgent(options) {
    const { systemPrompt, firstMessage, voiceSettings } = options;
    
    try {
      const result = await this.requestBridge('/create-voice-agent', 'POST', {
        systemPrompt,
        firstMessage,
        voiceSettings: voiceSettings || {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      });
      
      return {
        agent_id: this.agentId,
        mcp_result: result
      };
    } catch (error) {
      console.error('Failed to create voice agent via MCP:', error);
      
      // Fallback to direct API
      const signedUrl = await this.getSignedUrl();
      return {
        agent_id: this.agentId,
        signed_url: signedUrl
      };
    }
  }

  /**
   * Generate speech via MCP
   */
  async generateSpeech(text, voiceId = null, outputPath = './speech.mp3') {
    return await this.requestBridge('/text-to-speech', 'POST', {
      text,
      voiceId: voiceId || this.agentId,
      outputPath
    });
  }

  /**
   * Call any MCP tool
   */
  async callTool(toolName, args) {
    return await this.requestBridge('/call-tool', 'POST', {
      name: toolName,
      arguments: args
    });
  }

  /**
   * Fallback: Get signed URL directly from ElevenLabs
   */
  async getSignedUrl() {
    return new Promise((resolve, reject) => {
      const path = `/v1/convai/conversation/get_signed_url?agent_id=${this.agentId}`;
      
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        path,
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: this.timeout
      };

      const req = https.request(requestOptions, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsedData = JSON.parse(responseData);
              resolve(parsedData.signed_url);
            } catch (error) {
              reject(new Error(`Failed to parse response: ${error.message}`));
            }
          } else {
            reject(new Error(`API request failed with status ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timed out'));
      });
      
      req.end();
    });
  }
}

/**
 * Create a new ElevenLabs MCP Bridge client
 */
export function createElevenLabsMcpBridgeClient(options = {}) {
  return new ElevenLabsMcpBridgeClient(options);
} 