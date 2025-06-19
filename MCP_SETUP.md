# ElevenLabs MCP Server Setup

## Environment Configuration

To use your custom ElevenLabs MCP server, update your `.env` file with the following settings:

```
# MCP configuration
USE_MCP=true
MCP_URL=https://elevenlabs-mcp-f20g.onrender.com
```

## How It Works

The Node.js application in this repository is already configured to work with an external MCP server. The `elevenLabsMcp.js` file contains the client code that communicates with the MCP server.

When `USE_MCP` is set to `true`, the application will send requests to the specified `MCP_URL` instead of making direct API calls to ElevenLabs.

## Deployment

When deploying your Node.js application to Render.com or another hosting provider, make sure to set these environment variables in the deployment settings:

1. `USE_MCP=true`
2. `MCP_URL=https://elevenlabs-mcp-f20g.onrender.com`

## Testing

To test if the MCP server is working correctly, you can:

1. Start your Node.js application locally with the updated environment variables
2. Make a test call using the `/start-call` endpoint
3. Check the logs to see if the application is successfully communicating with the MCP server

## Troubleshooting

If you encounter issues:

1. Check that your MCP server is running and accessible at `https://elevenlabs-mcp-f20g.onrender.com`
2. Verify that your ElevenLabs API key and agent ID are correctly set
3. Look for any errors in the application logs related to MCP communication 