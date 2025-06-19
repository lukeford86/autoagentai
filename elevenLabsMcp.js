// elevenLabsMcp.js
import https from 'https';

/**
 * Client for interacting with the ElevenLabs API directly
 * This implementation doesn't require the MCP server to be running
 */
export class ElevenLabsMcpClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.ELEVENLABS_API_KEY;
    this.agentId = options.agentId || process.env.ELEVENLABS_AGENT_ID;
    this.timeout = options.timeout || 10000;
    
    if (!this.apiKey) {
      throw new Error('ELEVENLABS_API_KEY is required');
    }
    
    if (!this.agentId) {
      throw new Error('ELEVENLABS_AGENT_ID is required');
    }
  }

  /**
   * Make a request to the ElevenLabs API
   * @param {Object} options - Request options
   * @returns {Promise<Object>} - The response data
   */
  async request(options) {
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
   * Get a signed WebSocket URL for an ElevenLabs Conversational AI agent
   * @returns {Promise<string>} - The signed WebSocket URL
   */
  async getSignedUrl() {
    const path = `/v1/convai/conversation/get_signed_url?agent_id=${this.agentId}`;
    const response = await this.request({ path });
    return response.signed_url;
  }

  /**
   * Create a voice agent for outbound calls
   * This is a mock implementation that simply returns the agent ID and signed URL
   * @param {Object} options - Agent options
   * @returns {Promise<Object>} - The agent response
   */
  async createVoiceAgent(options) {
    const signedUrl = await this.getSignedUrl();
    
    return {
      agent_id: this.agentId,
      signed_url: signedUrl
    };
  }

  /**
   * Send audio to the voice agent and get a response
   * This is a mock implementation as this should be handled via WebSocket
   * @param {Buffer} audioBuffer - The audio buffer
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} - The response
   */
  async sendAudioToAgent(audioBuffer, agentId) {
    // This would normally be handled via WebSocket
    // We're returning a mock response here
    return {
      success: true,
      message: "Audio should be sent via WebSocket, not REST API"
    };
  }

  /**
   * Send a silence notification to the agent
   * This is a mock implementation as this should be handled via WebSocket
   * @param {string} agentId - The agent ID
   * @param {number} duration - The silence duration in milliseconds
   * @param {boolean} isInitialResponse - Whether this is the initial response
   * @returns {Promise<Object>} - The response
   */
  async notifySilence(agentId, duration, isInitialResponse) {
    // This would normally be handled via WebSocket
    // We're returning a mock response here
    return {
      success: true,
      message: "Silence notifications should be sent via WebSocket, not REST API"
    };
  }

  /**
   * Close the voice agent
   * This is a mock implementation as this should be handled via WebSocket
   * @param {string} agentId - The agent ID
   * @returns {Promise<Object>} - The response
   */
  async closeAgent(agentId) {
    // This would normally be handled via WebSocket
    // We're returning a mock response here
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