# Twilio + ElevenLabs Voice AI Integration

This repository contains code for integrating Twilio for outbound calling with ElevenLabs for AI voice conversations.

## Repository Structure

This repository is organized into multiple branches for deployment to separate services:

- `main` - Contains shared code and documentation
- `node` - Contains the Node.js application for deployment to a web service
- `python-mcp` - Contains the Python MCP server for deployment to a separate service

## Deployment Architecture

The application is designed to be deployed as two separate services on Render.com:

1. **Node.js Application** (from the `node` branch)
   - Handles Twilio integration
   - Makes outbound calls
   - Streams audio to/from ElevenLabs
   - Can work with or without the MCP server

2. **Python MCP Server** (from the `python-mcp` branch)
   - Provides improved performance for ElevenLabs integration
   - Handles voice agent creation and management
   - Processes audio data for ElevenLabs

## Getting Started

### For Node.js Application Development

```bash
git checkout node
bun install
cp .env.example .env
# Edit .env with your credentials
bun start
```

### For Python MCP Server Development

```bash
git checkout python-mcp
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your credentials
python mcp_server.py
```

## Deployment Instructions

### Deploying the Node.js Application

1. Create a new Web Service on Render.com
2. Connect to your GitHub repository
3. Select the `node` branch
4. Configure the environment variables as specified in `.env.example`
5. Deploy the service

### Deploying the Python MCP Server

1. Create a new Web Service on Render.com
2. Connect to your GitHub repository
3. Select the `python-mcp` branch
4. Configure the environment variables as specified in `.env.example`
5. Deploy the service

### Connecting the Services

Once both services are deployed, update the Node.js application's environment variables:

- Set `USE_MCP=true`
- Set `MCP_URL` to the URL of your deployed Python MCP server

## License

This project is licensed under the MIT License - see the LICENSE file for details. 