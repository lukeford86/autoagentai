import Twilio from 'twilio';
import WebSocket from 'ws';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { twiml: { VoiceResponse } } = Twilio;

// helper to get your signed URL
async function getElevenUrl(log) {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  log.info('Fetching ElevenLabs signed URL', { url });
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY }});
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs URL fetch failed ${res.status}: ${text}`);
  }
  const { signed_url } = await res.json();
  log.info('Received ElevenLabs signed URL');
  return signed_url;
}

/** 1) Place the call with <Start><Stream> + <Pause> **/
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host;

  // build unidirectional Stream + a long Pause to keep call alive
  const vr = new VoiceResponse();
  vr.start().stream({ url: `wss://${host}/media-stream` });
  vr.pause({ length: 3600 });       // pause 1 hour

  const twiml = vr.toString();
  req.log.info('Generated TwiML', { twiml });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml
    });
    req.log.info('Call initiated', { callSid: call.sid });
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err, 'Call initiation failed');
    return reply.status(500).send({ error: 'Call initiation failed' });
  }
}

/** 2) Proxy Twilio ⟷ ElevenLabs **/
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  req.log.info('🛰️  Twilio WS connected', {
    proto: req.headers['sec-websocket-protocol']
  });

  let elevenSocket, streamSid;

  twilioSocket.on('message', async raw => {
    // Twilio sends JSON text messages for control
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return req.log.error(e, 'Failed to parse Twilio WS message');
    }
    req.log.info('Twilio →', msg);

    switch (msg.event) {
      case 'connected':
        req.log.info('Event: connected');
        break;

      case 'start':
        // grab the Twilio streamSid
        streamSid = msg.start.streamSid;
        req.log.info('Event: start', { streamSid, tracks: msg.start.tracks });

        // now wire up ElevenLabs
        try {
          const wsUrl = await getElevenUrl(req.log);
          req.log.info('Opening ElevenLabs WS', { wsUrl });
          elevenSocket = new WebSocket(wsUrl);

          elevenSocket.on('open', () => {
            req.log.info('ElevenLabs WS open – sending init prompt');
            elevenSocket.send(JSON.stringify({
              system_prompt: 'You are a friendly real‐estate agent offering free home valuations.',
              first_message: "Hi, I'm Luke from Acme Realty. Would you like a free home valuation today?",
              stream: true
            }));
          });

          elevenSocket.on('message', data => {
            req.log.info('ElevenLabs → raw audio bytes', { length: data.length });
            const payload = Buffer.from(data).toString('base64');

            // send back a “media” JSON frame to Twilio
            const out = JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload }
            });
            req.log.info('📤 media → Twilio', { bytes: out.length });
            twilioSocket.send(out);
          });

          elevenSocket.on('error', err => {
            req.log.error(err, 'ElevenLabs WS error');
          });

          elevenSocket.on('close', (code, reason) => {
            req.log.info('ElevenLabs WS closed', { code, reason });
            // once the agent closes, tell Twilio to stop & hangup
            const stopMsg = JSON.stringify({ event: 'stop', streamSid });
            twilioSocket.send(stopMsg);
            twilioSocket.close();
          });

        } catch (err) {
          req.log.error(err, 'Failed to open ElevenLabs WS');
          twilioSocket.close();
        }
        break;

      case 'media':
        // forward only the caller’s audio frames
        if (msg.media.track === 'inbound') {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          req.log.info('📥 forwarding caller audio', { bytes: pcm.length });
          if (elevenSocket?.readyState === WebSocket.OPEN) {
            elevenSocket.send(pcm);
          } else {
            req.log.warn('ElevenLabs WS not open yet – dropping chunk');
          }
        }
        break;

      case 'stop':
        req.log.info('Event: stop – tearing down');
        elevenSocket?.close();
        twilioSocket.close();
        break;

      default:
        req.log.info('Event: (unhandled)', { event: msg.event });
    }
  });

  twilioSocket.on('close', (code, reason) => {
    req.log.info('🔌 Twilio WS closed', { code, reason });
    elevenSocket?.close();
  });

  twilioSocket.on('error', err => {
    req.log.error(err, 'Twilio WS error');
    elevenSocket?.close();
  });
}
