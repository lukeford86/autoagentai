const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Serve dynamic TwiML ---
app.get('/twiml', (req, res) => {
  const agentId = req.query.agent_id;
  const voiceId = req.query.voice_id;

  if (!agentId || !voiceId) {
    return res.status(400).send('Missing agent_id or voice_id');
  }

  const response = new VoiceResponse();
  response.start().stream({
    url: `wss://${req.headers.host}/media?agent_id=${agentId}&voice_id=${voiceId}`,
  });

  // NO intro message — we stay silent until the person speaks
  res.type('text/xml');
  res.send(response.toString());
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
