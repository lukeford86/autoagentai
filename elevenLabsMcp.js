// elevenLabsMcp.js
import http from 'http';
import https from 'https';

/**
 * Client for interacting with the ElevenLabs API directly
 * This implementation doesn't require the MCP server to be running
 */
export class ElevenLabsMcpClient {
  constructor(options = {}) {
    // For direct API access
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.agentId = options.agentId || process.env.ELEVENLABS_AGENT_ID;
    
    // For MCP server access
    this.useMcp = options.useMcp !== undefined ? options.useMcp : process.env.USE_MCP === 'true';
    this.mcpUrl = options.mcpUrl || process.env.MCP_URL || 'http://localhost:8000';
    this.timeout = options.timeout || 10000;
    
    if (!this.apiKey) {
      throw new Error('ELEVENLABS_API_KEY is required');
    }
    
    if (!this.agentId) {
      throw new Error('ELEVENLABS_AGENT_ID is required');
    }
    
    // Parse MCP URL
    if (this.useMcp) {
      try {
        const url = new URL(this.mcpUrl);
        this.mcpProtocol = url.protocol.replace(':', '');
        this.mcpHost = url.hostname;
        this.mcpPort = url.port ? parseInt(url.port) : (this.mcpProtocol === 'https' ? 443 : 80);
        this.mcpPath = url.pathname === '/' ? '/mcp' : `${url.pathname}/mcp`;
      } catch (error) {
        console.error('Invalid MCP URL:', error);
        this.useMcp = false;
      }
    }
  }

  /**
   * Make a request to the ElevenLabs API
   * @param {Object} options - Request options
   * @returns {Promise<Object>} - The response data
   */
  async requestApi(options) {
    const { path, method = 'GET', headers = {}, body } = options;
    
    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: 'api.elevenlabs.io',
        path,
        method,
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          ...headers
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
              const parsedData = responseData ? JSON.parse(responseData) : {};
              resolve(parsedData);
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

      if (body) {
        req.write(JSON.stringify(body));
      }
      
      req.end();
    });
  }

  /**
   * Make a request to the ElevenLabs MCP server
   * @param {Object} data - The request data
   * @returns {Promise<Object>} - The response data
   */
  async requestMcp(data) {
    return new Promise((resolve, reject) => {
      const requestData = JSON.stringify(data);
      
      const requestOptions = {
        hostname: this.mcpHost,
        port: this.mcpPort,
        path: this.mcpPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestData)
        },
        timeout: this.timeout
      };

      // Use http or https based on protocol
      const requester = this.mcpProtocol === 'https' ? https : http;
      
      const req = requester.request(requestOptions, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const parsedData = JSON.parse(responseData);
            resolve(parsedData);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
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

      req.write(requestData);
      req.end();
    });
  }

  /**
   * Get a signed WebSocket URL for an ElevenLabs Conversational AI agent
   * @returns {Promise<string>} - The signed WebSocket URL
   */
  async getSignedUrl() {
    const path = `/v1/convai/conversation/get_signed_url?agent_id=${this.agentId}`;
    const response = await this.requestApi({ path });
    return response.signed_url;
  }

  /**
   * Create a voice agent for outbound calls
   * @param {Object} options - Agent options
   * @returns {Promise<Object>} - The agent response
   */
  async createVoiceAgent(options) {
    const { systemPrompt, firstMessage, voiceSettings } = options;
    
    if (this.useMcp) {
      try {
        // Try using MCP server
        return await this.requestMcp({
          name: "create_voice_agent",
          arguments: {
            system_prompt: systemPrompt,
            first_message: firstMessage,
            voice_settings: voiceSettings || {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true
            }
          }
        });
      } catch (error) {
        console.error('Failed to use MCP server, falling back to direct API:', error);
      }
    }
    
    // Fallback to direct API
    const signedUrl = await this.getSignedUrl();
    return {
      agent_id: this.agentId,
      signed_url: signedUrl
    };
  }

  /**
   * Send audio to the voice agent and get a response
   * @param {Buffer} audioBuffer - The audio buffer
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} - The response
   */
  async sendAudioToAgent(audioBuffer, agentId) {
    if (this.useMcp) {
      try {
        return await this.requestMcp({
          name: "send_audio_to_agent",
          arguments: {
            audio_data: audioBuffer.toString('base64'),
            agent_id: agentId
          }
        });
      } catch (error) {
        console.error('Failed to send audio to MCP agent:', error);
      }
    }
    
    // Fallback response for direct API
    return {
      success: true,
      message: "Audio should be sent via WebSocket, not REST API"
    };
  }

  /**
   * Send a silence notification to the agent
   * @param {string} agentId - The agent ID
   * @param {number} duration - The silence duration in milliseconds
   * @param {boolean} isInitialResponse - Whether this is the initial response
   * @returns {Promise<Object>} - The response
   */
  async notifySilence(agentId, duration, isInitialResponse) {
    if (this.useMcp) {
      try {
        return await this.requestMcp({
          name: "notify_silence",
          arguments: {
            agent_id: agentId,
            duration: duration,
            is_initial_response: isInitialResponse
          }
        });
      } catch (error) {
        console.error('Failed to notify silence to MCP agent:', error);
      }
    }
    
    // Fallback response for direct API
    return {
      success: true,
      message: "Silence notifications should be sent via WebSocket, not REST API"
    };
  }

  /**
   * Close the voice agent
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} - The response
   */
  async closeAgent(agentId) {
    if (this.useMcp) {
      try {
        return await this.requestMcp({
          name: "close_agent",
          arguments: {
            agent_id: agentId
          }
        });
      } catch (error) {
        console.error('Failed to close MCP agent:', error);
      }
    }
    
    // Fallback response for direct API
    return {
      success: true,
      message: "Agent closure should be handled via WebSocket, not REST API"
    };
  }
}

/**
 * Create a new ElevenLabs client
 * @param {Object} options - Client options
 * @returns {ElevenLabsMcpClient} - The client instance
 */
export function createElevenLabsMcpClient(options = {}) {
  return new ElevenLabsMcpClient(options);
} 