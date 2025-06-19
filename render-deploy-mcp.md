# MCP Bridge Deployment on Render - Troubleshooting

## Current Issue: MCP Request Timeout

The error `❌ Failed to start MCP Bridge: Error: MCP request timeout` means the Python MCP server isn't starting correctly.

## Solution 1: Use Direct API (Recommended for Production)

### Render Settings:
- **Build Command**: `npm install`
- **Start Command**: `npm run start:safe`

This uses direct ElevenLabs API - fully functional, no MCP needed.

## Solution 2: Fix MCP Bridge (Optional)

### Requirements for MCP Bridge:
1. **Python 3.8+** available on Render
2. **Proper Python package installation**
3. **Working stdio communication**

### Updated Build Command:
```bash
# Ensure Python and pip are available
python3 --version && pip3 install elevenlabs-mcp && npm install
```

### Alternative with Requirements File:
Create `requirements.txt`:
```
elevenlabs-mcp>=0.4.0
```

Then use build command:
```bash
pip3 install -r requirements.txt && npm install
```

### Debug Commands:
Add to `mcp-bridge-server.js` for debugging:
```javascript
console.log('Python version:', process.env.PYTHON_VERSION);
console.log('Available Python:', process.env.PATH);

// Test if elevenlabs-mcp is available
const testProcess = spawn('python3', ['-c', 'import elevenlabs_mcp; print("MCP available")']);
```

## Solution 3: Separate MCP Service

Deploy MCP bridge as separate Render service:

### Service 1: Main App
- **Build**: `npm install`
- **Start**: `npm run start`
- **Environment**: All Twilio + ElevenLabs vars

### Service 2: MCP Bridge
- **Build**: `pip3 install elevenlabs-mcp && npm install`
- **Start**: `npm run start:mcp-bridge`
- **Environment**: `ELEVENLABS_API_KEY`

### Connect Services:
In main app environment:
```
MCP_BRIDGE_URL=https://your-mcp-bridge-service.onrender.com
```

## Current Status

Your service is **working perfectly** with direct ElevenLabs API. MCP bridge adds advanced features but isn't required for basic voice calls. 