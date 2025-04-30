// server.js
require('dotenv').config();

const express            = require('express');
const bodyParser         = require('body-parser');
const WebSocket          = require('ws');
const { VoiceResponse }  = require('twilio').twiml;
const { Deepgram }       = require('@deepgram/sdk');
const { ElevenLabsClient } = require('elevenlabs');
const OpenAI             = require('openai');

// ————————————————————————————————————————————————————————————————
//  Environment & sanity checks
// ————————————————————————————————————————————————————————————————
const {
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  OPENROUTER_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 10000,
} = process.env;

for (let key of ['DEEPGRAM_API_KEY','ELEVENLABS_API_KEY','OPENROUTER_API_KEY']) {
  if (!process.env[key]) {
    console.error(`🚨 Missing required env var: ${key}`);
    process.exit(1);
  }
}

// Twilio credentials are only needed for Calls.update
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  const Twilio = require('twilio');
  twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing; call updates will be disabled');
}

// ————————————————————————————————————————————————————————————————
//  SDK clients
// ————————————————————————————————————————————————————————————————
const dgClient = new Deepgram(DEEPGRAM_API_KEY);
const eleven   = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
const openai   = new OpenAI({ apiKey: OPENROUTER_API_KEY });

// ————————————————————————————————————————————————————————————————
//  Express + TwiML endpoint
// ————————————————————————————————————————————————————————————————
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

app.post('/twiml', (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log('[TwiML] params:', { agent_id, voice_id, contact_name, address });

  // Create minimal TwiML that connects to the WebSocket
  const twiml = new VoiceResponse();
  
  // 1) Fork inbound audio to our WS
  twiml.start().stream({
    url: `wss://${req.headers.host}/media`,
    track: 'inbound_track'
  });
  
  // 2) Add a small delay to allow WS to establish before audio begins
  twiml.pause({ length: 1 });
  
  // 3) Keep the call open for up to 10 minutes
  twiml.pause({ length: 600 });

  console.log('[TwiML XML]\n' + twiml.toString());
  res.type('text/xml').send(twiml.toString());
});

// ————————————————————————————————————————————————————————————————
//  Server + WebSocket upgrade
// ————————————————————————————————————————————————————————————————
const server = app.listen(PORT, () => {
  console.log(`✅ Listening on port ${PORT} — service live`);
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  console.log('[Upgrade] request for', req.url);
  if (req.url.startsWith('/media')) {
    console.log('[Upgrade] upgrading to WS');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    console.log('[Upgrade] not /media, destroying socket');
    socket.destroy();
  }
});

// ————————————————————————————————————————————————————————————————
//  WebSocket handler: Deepgram STT + AI/TTS loop
// ————————————————————————————————————————————————————————————————
wss.on('connection', (ws, req) => {
  console.log('[WS] Connection established:', req.url);

  let dgSocket, callSid;
  let voiceId, contactName, address, agentId;

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[WS] Invalid JSON:', raw);
      return;
    }

    if (msg.event === 'start') {
      // Extract call context
      callSid = msg.start.callSid;
      
      // Extract parameters from URL query string in start event
      // This is the key change - use customParameters if available, otherwise try parameters
      if (msg.start.customParameters) {
        ({ agent_id: agentId, voice_id: voiceId, contact_name: contactName, address } = msg.start.customParameters);
      } else if (msg.start.parameters) {
        // Try to get from parameters instead
        ({ agent_id: agentId, voice_id: voiceId, contact_name: contactName, address } = msg.start.parameters);
      } else {
        // If neither exists, check if they're directly in the start object
        agentId = msg.start.agent_id;
        voiceId = msg.start.voice_id;
        contactName = msg.start.contact_name;
        address = msg.start.address;
        
        if (!voiceId || !contactName || !address) {
          console.warn('[WS] Unable to find required parameters in start event', msg.start);
        }
      }
      
      console.log('[WS] start event:', { callSid, agentId, voiceId, contactName, address });

      // Play initial greeting with ElevenLabs voice
      if (voiceId && contactName && address) {
        // Send initial greeting immediately using ElevenLabs
        const initialGreeting = `Hi ${contactName}, just confirming your appointment at ${address}.`;
        playElevenLabsAudio(initialGreeting, voiceId, ws).catch(err => {
          console.error('[Initial Greeting] Error:', err);
        });
      } else {
        console.warn('[WS] Missing parameters for initial greeting');
      }

      // Begin Deepgram live transcription
      try {
        dgSocket = dgClient.transcription.live({
          encoding: 'mulaw',
          sample_rate: 8000,
          punctuate: true,
          language: 'en-US'
        });
        
        // Setup listeners before sending data
        dgSocket.addListener('transcriptReceived', dg => {
          if (!dg.is_final) return;
          const text = dg.channel.alternatives[0].transcript.trim();
          console.log('[Deepgram final]', text);
          if (text) {
            handleAiReply(text, { callSid, voiceId, contactName, address }, ws);
          }
        });
        
        dgSocket.addListener('error', error => {
          console.error('[Deepgram] Error:', error);
        });
        
        dgSocket.addListener('close', () => {
          console.log('[Deepgram] Connection closed');
        });
        
        console.log('[Deepgram] WebSocket connection established');
      } catch (err) {
        console.error('[Deepgram] Failed to initialize:', err);
      }
    }
    else if (msg.event === 'media') {
      // Feed inbound audio to Deepgram
      const buffer = Buffer.from(msg.media.payload, 'base64');
      if (dgSocket && dgSocket.getReadyState() === 1) { // 1 = OPEN in WebSocket standard
        dgSocket.send(buffer);
      }
    }
    else if (msg.event === 'stop') {
      console.log('[WS] stop event');
      if (dgSocket) {
        try {
          dgSocket.finish();
        } catch (err) {
          console.error('[Deepgram] Error finishing connection:', err);
        }
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] disconnected');
    if (dgSocket) {
      try {
        dgSocket.finish();
      } catch (err) {
        console.error('[Deepgram] Error finishing connection on WS close:', err);
      }
    }
  });
});

// ————————————————————————————————————————————————————————————————
//  ElevenLabs TTS Helper
// ————————————————————————————————————————————————————————————————
async function playElevenLabsAudio(text, voiceId, ws) {
  console.log('[ElevenLabs] Generating audio for:', text);
  
  try {
    // Generate audio from ElevenLabs
    const ttsStream = await eleven.generate({
      voice: voiceId,
      text: text,
      model_id: 'eleven_multilingual_v2',
      stream: true
    });

    // Stream the audio back to the WebSocket
    for await (const chunk of ttsStream) {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          track: 'outbound_track',
          payload: chunk.toString('base64'),
        }
      }));
    }
    
    console.log('[ElevenLabs] Done streaming audio');
    return true;
  } catch (err) {
    console.error('[ElevenLabs] Error generating audio:', err);
    throw err;
  }
}

// ————————————————————————————————————————————————————————————————
//  AI → ElevenLabs TTS → (optional) Twilio Calls.update
// ————————————————————————————————————————————————————————————————
async function handleAiReply(userText, ctx, ws) {
  try {
    const { callSid, voiceId, contactName, address } = ctx;
    console.log('[AI] user said:', userText);

    // Skip if missing essential context
    if (!voiceId || !contactName || !address) {
      console.warn('[AI] Missing required context', ctx);
      return;
    }

    // Generate AI reply
    const systemPrompt = `
      You are an appointment reminder assistant.
      Contact: ${contactName}, Address: ${address}.
      You are confirming their appointment at the address.
      Keep your responses brief and helpful.
    `;
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userText },
      ]
    });
    const reply = aiRes.choices[0].message.content.trim();
    console.log('[AI] reply:', reply);

    // Use our helper function to play the audio
    await playElevenLabsAudio(reply, voiceId, ws);

    // Optionally update the call's TwiML if Twilio client is configured
    if (twilioClient) {
      console.log('[Twilio] updating call TwiML for next turn');
      const tw = new VoiceResponse();
      tw.start().stream({ 
        url: `wss://${process.env.HOSTNAME||ws._socket.remoteAddress}/media`, 
        track: 'inbound_track' 
      });
      tw.pause({ length: 600 });
      await twilioClient.calls(callSid).update({ twiml: tw.toString() });
      console.log('[Twilio] call TwiML updated');
    }
  } catch (err) {
    console.error('[handleAiReply] error:', err);
  }
}
