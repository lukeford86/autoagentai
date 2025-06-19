// twilioHandler.js
import Twilio from 'twilio';
import { WebSocket } from 'ws';
import { createElevenLabsMcpClient } from './elevenLabsMcp.js';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { twiml: { VoiceResponse } } = Twilio;

// Create ElevenLabs client
const elevenLabsClient = createElevenLabsMcpClient();

// Constants for conversation timing
const INITIAL_SILENCE_THRESHOLD = 1500; // 1.5 seconds for initial response
const CONVERSATION_SILENCE_THRESHOLD = 2000; // 2 seconds for ongoing conversation
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

/** Fetch a signed URL for your ElevenLabs Conversational AI agent with retry logic */
async function getElevenUrl(log, retryCount = 0) {
  log.info('⏳ fetching ElevenLabs signed URL', { retryCount });
  
  try {
    const signedUrl = await elevenLabsClient.getSignedUrl();
    log.info('✅ got ElevenLabs signed URL');
    return signedUrl;
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      log.warn('ElevenLabs URL fetch error, retrying...', { error: err.message, retryCount });
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * Math.pow(2, retryCount)));
      return getElevenUrl(log, retryCount + 1);
    }
    throw err;
  }
}

/**
 * 1) HTTP POST /start-call
 *    Create an outbound call with <Connect><Stream>, which blocks TwiML
 */
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  if (!to) {
    return reply.status(400).send({ error: 'Phone number is required' });
  }

  const host = req.headers.host;
  const vr = new VoiceResponse();
  const connect = vr.connect();
  
  // Configure stream with parameters for better audio quality
  connect.stream({ 
    url: `wss://${host}/media-stream`,
    track: 'inbound_track',
    parameter: {
      audioFormat: 'mulaw',
      sampleRate: 8000
    }
  });

  const twiml = vr.toString();
  req.log.info('📞 TwiML for outbound call', { twiml });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml,
      statusCallback: `https://${host}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'Enable', // Enable answering machine detection
      asyncAmd: 'true', // Asynchronous AMD
      asyncAmdStatusCallback: `https://${host}/amd-status` // AMD status callback
    });
    
    req.log.info('✅ Call initiated', { callSid: call.sid });
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err, '❌ Call initiation failed');
    return reply.status(500).send({ error: 'Call initiation error' });
  }
}

/**
 * 2) Proxy the Twilio WebSocket at /media-stream
 */
export async function handleMediaStreamSocket(twilioSocket, request, log) {
  log.info('🔌 Twilio WS connected', {
    protocol: request.headers['sec-websocket-protocol']
  });

  let elevenSocket, streamSid;
  let isCallAnswered = false;
  let hasReceivedInitialAudio = false;
  let silenceTimer = null;
  let isInitialResponse = true;
  let audioBuffer = Buffer.alloc(0);
  const BUFFER_THRESHOLD = 1024; // Buffer size before sending to ElevenLabs

  // Handle WebSocket connection errors
  const handleError = (err, source) => {
    log.error(err, `❌ ${source} error`);
    if (silenceTimer) clearTimeout(silenceTimer);
    
    // Close WebSocket if it exists
    if (elevenSocket?.readyState === WebSocket.OPEN) {
      elevenSocket.close();
    }
    
    twilioSocket.close();
  };

  twilioSocket.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return handleError(e, 'Invalid JSON from Twilio');
    }
    
    log.info('💬 Twilio →', msg);

    switch (msg.event) {
      case 'connected':
        log.info('✅ Twilio event "connected"');
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        log.info('▶️ Twilio event "start"', {
          streamSid, 
          tracks: msg.start.tracks
        });
        break;

      case 'media':
        if (msg.media.track === 'inbound') {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          
          // Buffer audio data
          audioBuffer = Buffer.concat([audioBuffer, pcm]);
          
          // Check if this is the first audio we've received
          if (!hasReceivedInitialAudio && audioBuffer.length > 0) {
            hasReceivedInitialAudio = true;
            log.info('👋 Received initial audio from caller');
            
            try {
              // Get WebSocket URL directly from ElevenLabs API
              const wsUrl = await getElevenUrl(log);
              log.info('🔌 opening ElevenLabs WS', { wsUrl });
              elevenSocket = new WebSocket(wsUrl);

              elevenSocket.on('open', () => {
                log.info('🗨️ ElevenLabs WS open – sending init prompt');
                elevenSocket.send(JSON.stringify({
                  system_prompt: 'You are a friendly real estate agent offering free property valuations. Be conversational and natural. Keep responses concise and engaging.',
                  first_message: "Hi, I'm calling from Acme Realty. I noticed your property might be a good fit for our current buyers. Would you be interested in a free valuation?",
                  stream: true,
                  voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    style: 0.0,
                    use_speaker_boost: true
                  }
                }));
              });

              elevenSocket.on('message', data => {
                if (data instanceof Buffer) {
                  log.info('🗨️ ElevenLabs → audio chunk', { bytes: data.length });
                  const payload = data.toString('base64');
                  const out = JSON.stringify({
                    event: 'media',
                    streamSid,
                    media: { payload }
                  });
                  log.info('📤 sending media → Twilio', { bytes: out.length });
                  twilioSocket.send(out);
                }
              });

              elevenSocket.on('error', err => handleError(err, 'ElevenLabs WS'));
              elevenSocket.on('close', (code, reason) => {
                log.info('✂️ ElevenLabs WS closed', { code, reason });
                const stopMsg = JSON.stringify({ event: 'stop', streamSid });
                twilioSocket.send(stopMsg);
                twilioSocket.close();
              });
            } catch (err) {
              handleError(err, 'ElevenLabs connection');
            }
          }

          // Forward buffered audio to ElevenLabs
          if (audioBuffer.length >= BUFFER_THRESHOLD && elevenSocket?.readyState === WebSocket.OPEN) {
            elevenSocket.send(audioBuffer);
            audioBuffer = Buffer.alloc(0);
            
            // Reset silence timer when we receive audio
            if (silenceTimer) {
              clearTimeout(silenceTimer);
            }
            
            // Set new silence timer with appropriate threshold
            const threshold = isInitialResponse ? INITIAL_SILENCE_THRESHOLD : CONVERSATION_SILENCE_THRESHOLD;
            silenceTimer = setTimeout(() => {
              log.info('🤫 Detected silence, prompting for response', { 
                threshold,
                isInitialResponse 
              });
              
              if (elevenSocket?.readyState === WebSocket.OPEN) {
                elevenSocket.send(JSON.stringify({
                  type: 'silence_detected',
                  duration: threshold,
                  isInitialResponse
                }));
              }
              
              isInitialResponse = false;
            }, threshold);
          }
        }
        break;

      case 'stop':
        log.info('⏹️ Twilio event "stop" — tearing down');
        if (silenceTimer) clearTimeout(silenceTimer);
        
        // Close WebSocket if it exists
        if (elevenSocket?.readyState === WebSocket.OPEN) {
          elevenSocket.close();
        }
        
        twilioSocket.close();
        break;

      default:
        log.info('ℹ️ Unhandled Twilio event', { event: msg.event });
    }
  });

  twilioSocket.on('close', (code, reason) => {
    log.info('🔌 Twilio WS closed', { code, reason });
    if (silenceTimer) clearTimeout(silenceTimer);
    
    // Close WebSocket if it exists
    if (elevenSocket?.readyState === WebSocket.OPEN) {
      elevenSocket.close();
    }
  });

  twilioSocket.on('error', err => handleError(err, 'Twilio WS'));
}

export async function handleCallStatus(req, reply) {
  const callStatus = req.body;
  req.log.info({
    callSid: callStatus.CallSid,
    callStatus: callStatus.CallStatus,
    callDuration: callStatus.CallDuration,
    direction: callStatus.Direction,
    from: callStatus.From,
    to: callStatus.To,
    timestamp: callStatus.Timestamp,
    rawStatus: callStatus
  }, 'Call status update received');
  
  return reply.send({ ok: true });
}

export async function handleAmdStatus(req, reply) {
  const amdStatus = req.body;
  req.log.info({
    callSid: amdStatus.CallSid,
    amdResult: amdStatus.AnsweredBy,
    rawStatus: amdStatus
  }, 'AMD status update received');
  
  return reply.send({ ok: true });
}
