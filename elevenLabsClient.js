import https from 'https';

const { ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID } = process.env;

export function getElevenLabsStream(ws) {
  const options = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
  };

  const req = https.request(options, (res) => {
    res.on('data', (chunk) => {
      ws.send(chunk);
    });

    res.on('end', () => {
      console.log('ElevenLabs audio stream finished.');
      ws.close();
    });
  });

  req.on('error', (error) => {
    console.error('Error with ElevenLabs stream:', error);
    ws.close();
  });

  const payload = JSON.stringify({
    text: "Hi there, this is a test call. I'm your real estate assistant calling about your property. Are you interested in getting a free valuation?",
    model_id: "eleven_monolingual_v1",
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  });

  req.write(payload);
  req.end();
}