// twilioHandler.js
import Twilio from 'twilio';
import { WebSocket } from 'ws';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { twiml: { VoiceResponse } } = Twilio;

/** Fetch a signed URL for your ElevenLabs Conversational AI agent */
async function getElevenUrl(log) {
  const uri = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  log.info('⏳ fetching ElevenLabs signed URL', { uri });
  const res = await fetch(uri, { headers: { 'xi-api-key': ELEVENLABS_API_KEY }});
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ElevenLabs URL fetch failed ${res.status}: ${txt}`);
  }
  const { signed_url } = await res.json();
  log.info('✅ got ElevenLabs signed URL');
  return signed_url;
}

/**
 * 1) HTTP POST /start-call
 *    Create an outbound call with <Connect><Stream>, which blocks TwiML
 */
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host   = req.headers.host;  // e.g. "autoagentai.onrender.com"

  const vr      = new VoiceResponse();
  const connect = vr.connect();
  connect.stream({ url: `wss://${host}/media-stream` });
  // nothing after Connect → the call stays open until we send 'stop'

  const twiml = vr.toString();
  req.log.info('📞 TwiML for outbound call', { twiml });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml
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
 *
 * @param {WebSocket} twilioSocket  – the ws connection from Twilio
 * @param {http.IncomingMessage} request – the upgrade request
 * @param {FastifyLoggerInstance} log – Fastify’s logger
 */
export async function handleMediaStreamSocket(twilioSocket, request, log) {
  log.info('🔌 Twilio WS connected', {
    protocol: request.headers['sec-websocket-protocol']
  });

  let elevenSocket, streamSid;

  twilioSocket.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return log.error(e, '❌ invalid JSON from Twilio WS');
    }
    log.info('💬 Twilio →', msg);

    switch (msg.event) {
      case 'connected':
        log.info('✅ Twilio event "connected"');
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        log.info('▶️ Twilio event "start"', {
          streamSid, tracks: msg.start.tracks
        });

        // open ElevenLabs WS
        try {
          const wsUrl = await getElevenUrl(log);
          log.info('🔌 opening ElevenLabs WS', { wsUrl });
          elevenSocket = new WebSocket(wsUrl);

          elevenSocket.on('open', () => {
            log.info('🗨️ ElevenLabs WS open – sending init prompt');
            elevenSocket.send(JSON.stringify({
              system_prompt: 'You are a real estate agent offering free valuations. Be friendly.',
              first_message: "Hi, I'm Luke from Acme Realty. Would you like a free valuation today?",
              stream: true
            }));
          });

          elevenSocket.on('message', data => {
            log.info('🗨️ ElevenLabs → audio chunk', { bytes: data.length });
            const payload = Buffer.from(data).toString('base64');
            const out = JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload }
            });
            log.info('📤 sending media → Twilio', { bytes: out.length });
            twilioSocket.send(out);
          });

          elevenSocket.on('error', err => {
            log.error(err, '❌ ElevenLabs WS error');
          });

          elevenSocket.on('close', (code, reason) => {
            log.info('✂️ ElevenLabs WS closed', { code, reason });
            // tell Twilio to stop & hang up
            const stopMsg = JSON.stringify({ event: 'stop', streamSid });
            twilioSocket.send(stopMsg);
            twilioSocket.close();
          });

        } catch (err) {
          log.error(err, '❌ failed to open ElevenLabs WS');
          twilioSocket.close();
        }
        break;

      case 'media':
        if (msg.media.track === 'inbound') {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          log.info('📥 forwarding caller audio → ElevenLabs', {
            bytes: pcm.length
          });
          if (elevenSocket?.readyState === WebSocket.OPEN) {
            elevenSocket.send(pcm);
          }
        }
        break;

      case 'stop':
        log.info('⏹️ Twilio event "stop" — tearing down');
        elevenSocket?.close();
        twilioSocket.close();
        break;

      default:
        log.info('ℹ️ Unhandled Twilio event', { event: msg.event });
    }
  });

  twilioSocket.on('close', (code, reason) => {
    log.info('🔌 Twilio WS closed', { code, reason });
    elevenSocket?.close();
  });

  twilioSocket.on('error', err => {
    log.error(err, '❌ Twilio WS error');
    elevenSocket?.close();
  });
}
