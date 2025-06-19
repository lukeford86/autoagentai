# ElevenLabs Integration Notes

## Current Configuration

This application now uses **direct ElevenLabs API integration** via WebSocket connections. The MCP server approach was incompatible because:

1. The [official ElevenLabs MCP server](https://github.com/elevenlabs/elevenlabs-mcp) uses JSON-RPC over stdio (Model Context Protocol)
2. It's designed for AI clients like Claude Desktop, not HTTP API integration
3. Our Twilio integration requires real-time WebSocket communication

## Environment Configuration

To use the direct ElevenLabs integration, ensure your `.env` file has:

```
# ElevenLabs configuration  
ELEVENLABS_API_KEY=your_api_key_here
ELEVENLABS_AGENT_ID=your_agent_id_here

# Disable MCP (use direct API)
USE_MCP=false
```

## How It Works

The application directly connects to ElevenLabs' Conversational AI WebSocket API for real-time voice interactions during phone calls.

## Deployment

When deploying your Node.js application to Render.com or another hosting provider, make sure to set these environment variables:

1. `ELEVENLABS_API_KEY=your_api_key_here`
2. `ELEVENLABS_AGENT_ID=your_agent_id_here` 
3. `USE_MCP=false` (or leave unset)

## Testing

To test if the ElevenLabs integration is working:

1. Visit `/env-check` to verify all required environment variables are set
2. Make a test call using the `/start-call` endpoint
3. Check the logs for successful WebSocket connections to ElevenLabs

## Troubleshooting

If you encounter issues:

1. Verify your ElevenLabs API key has sufficient credits
2. Ensure your ElevenLabs agent ID is valid and active
3. Check the application logs for WebSocket connection errors
4. Test the `/health` endpoint to confirm the service is running

## About MCP

The [ElevenLabs MCP server](https://github.com/elevenlabs/elevenlabs-mcp) is designed for AI clients like Claude Desktop that can communicate via the Model Context Protocol. For real-time voice applications like this Twilio integration, direct API access provides better performance and reliability. 