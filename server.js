const express = require('express');
const { twiml: { VoiceResponse } } = require('twilio');
const { Deepgram } = require('@deepgram/sdk');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Env vars
const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
const openRouterApiKey = process.env.OPENROUTER_API_KEY;
const elevenlabsApiKey = process.env.ELEVENLABS_API_KEY;

const deepgram = new Deepgram(deepgramApiKey);

// --- Serve TwiML dynamically ---
app.all('/twiml', (req, res) => {
  try {
    console.log('✅ [TwiML] /twiml hit');

    const params = req.query; // Always from query for Twilio

    const agentId = params.agent_id;
    const voiceId = params.voice_id;
    const contactName = params.contact_name;
    const address = params.address;

    if (!agentId || !voiceId || !contactName || !address) {
      console.error('❌ [TwiML] Missing required fields:', { agentId, voiceId, contactName, address });
      return res.status(400).send('Missing required fields (agent_id, voice_id, contact_name, address)');
    }

    const response = new VoiceResponse();
    response.start().stream({
      url: `wss://${req.headers.host}/media?agent_id=${agentId}&voice_id=${voiceId}&contact_name=${encodeURIComponent(contactName)}&address=${encodeURIComponent(address)}`
    });

    res.type('text/xml');
    res.send(response.toString());
  } catch (err) {
    console.error('❌ [TwiML Server Error]:', err);
    res.status(500).send('Internal Server Error');
  }
});

// --- Create HTTP + WebSocket server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media' });

// --- WebSocket Connections ---
wss.on('connection', (ws, req) => {
  console.log('📞 [Twilio] WebSocket connection established');

  ws.on('error', (error) => {
    console.error('❌ [WebSocket Connection Error]:', error);
  });

  ws.on('close', () => {
    console.log('🔒 [WebSocket Connection closed]');
  });

  try {
    const params = new URLSearchParams(req.url.split('?')[1]);
    const agentId = params.get('agent_id');
    const voiceId = params.get('voice_id');
    const contactName = params.get('contact_name');
    const address = params.get('address');

    console.log('🎯 [WebSocket Params]', { agentId, voiceId, contactName, address });

    const deepgramSocket = deepgram.transcription.live({
      language: 'en-AU',
      punctuate: true,
      interim_results: false,
      encoding: 'mulaw',
      sample_rate: 8000,
    });

    deepgramSocket.on('open', () => console.log('🔗 [Deepgram] Connected'));
    deepgramSocket.on('error', (error) => console.error('❌ [Deepgram Error]:', error));
    deepgramSocket.on('close', () => console.log('🔒 [Deepgram Closed]'));

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);

        if (message.event === 'start') {
          console.log(`✅ [Twilio] Call Started - StreamSid: ${message.streamSid}`);
        }

        if (message.event === 'media') {
          const audioData = message.media.payload;
          const buffer = Buffer.from(audioData, 'base64');
          if (deepgramSocket.readyState === 1) {
            deepgramSocket.send(buffer);
          }
        }

        if (message.event === 'stop') {
          console.log(`🛑 [Twilio] Call Stopped - StreamSid: ${message.streamSid}`);
          ws.close();
          deepgramSocket.finish();
        }
      } catch (err) {
        console.error('❌ [WebSocket Message Error]:', err);
      }
    });

    deepgramSocket.on('transcriptReceived', async (data) => {
      try {
        const transcript = data.channel.alternatives[0]?.transcript;
        if (transcript && transcript.length > 0) {
          console.log(`📝 [Deepgram Transcript]: ${transcript}`);

          const gptReply = await generateReplyFromGPT(transcript, contactName, address);
          const audioStream = await streamVoiceFromElevenLabs(gptReply, voiceId);

          audioStream.on('data', (chunk) => {
            if (ws.readyState === WebSocket.OPEN) {
              const payload = Buffer.from(chunk).toString('base64');
              ws.send(JSON.stringify({ event: 'media', media: { payload } }));
            }
          });

          audioStream.on('end', () => console.log('✅ [ElevenLabs] Finished streaming voice'));
        }
      } catch (err) {
        console.error('❌ [Transcript Handling Error]:', err);
      }
    });

  } catch (err) {
    console.error('❌ [WebSocket Server Handling Error]:', err);
  }
});

// --- GPT System Prompt Function ---
async function generateReplyFromGPT(userText, contactName, address) {
  const systemPrompt = `You are an AI real estate assistant helping an agent. You are calling ${contactName} about ${address}. Offer a free property valuation and ask politely if they want an update on recent home sales in their area. Keep it friendly and natural.`;

  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText }
    ]
  }, {
    headers: {
      Authorization: `Bearer ${openRouterApiKey}`,
      'Content-Type': 'application/json'
    }
  });

  const reply = response.data.choices[0].message.content;
  console.log(`🤖 [GPT Reply]: ${reply}`);
  return reply;
}

// --- ElevenLabs Streaming ---
async function streamVoiceFromElevenLabs(text, voiceId) {
  const response = await axios({
    method: 'POST',
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    headers: {
      'xi-api-key': elevenlabsApiKey,
      'Content-Type': 'application/json',
    },
    data: {
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8
      }
    },
    responseType: 'stream'
  });

  return response.data;
}

// --- Start the Server ---
server.listen(PORT, () => {
  console.log(`✅ AI Call Server running on port ${PORT}`);
});
