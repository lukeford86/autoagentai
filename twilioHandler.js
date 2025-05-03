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

/** Fetch a signed WebSocket URL for your ElevenLabs agent **/
async function getElevenUrl(log) {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  log.info('⏳ Fetching ElevenLabs signed URL');
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY }});
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ElevenLabs URL fetch failed ${res.status}: ${txt}`);
  }
  const { signed_url } = await res.json();
  log.info('✅ Received ElevenLabs signed URL');
  return signed_url;
}

/** 1) Place the call using Connect/Stream for bidirectional media **/
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host; // e.g. "yourapp.render.com"

  // Build TwiML
  const vr = new VoiceResponse();
  const connect = vr.connect();
  connect.stream({ url: `wss://${host}/media-stream` });  // no track attr = both_tracks

  const twimlString = vr.toString();
  req.log.info('📞 Generated TwiML for call', { twiml: twimlString });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml: twimlString
    });
    req.log.info('✅ Call initiated', { callSid: call.sid });
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err, '❌ Call initiation failed');
    return reply.status(500).send({ error: 'Call initiation error' });
  }
}

/** 2) Handle the Twilio Media Stream WebSocket **/
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  req.log.info('🔌 Twilio WebSocket connection established');

  let elevenSocket;
  let streamSid;

  twilioSocket.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return req.log.error(e, '❌ Invalid JSON from Twilio');
    }
    req.log.info('💬 Twilio →', msg);

    switch (msg.event) {
      case 'connected':
        req.log.info('✅ Twilio event: connected');
        break;

      case 'start':
        // Stream metadata; grab the streamSid for future sends
        streamSid = msg.start.streamSid;
        req.log.info('✅ Twilio event: start', { streamSid, tracks: msg.start.tracks });

        // Open ElevenLabs WS
        try {
          const wsUrl = await getElevenUrl(req.log);
          elevenSocket = new WebSocket(wsUrl);

          elevenSocket.on('open', () => {
            req.log.info('🔌 ElevenLabs WebSocket open');
            // Kick off the conversation
            elevenSocket.send(JSON.stringify({
              system_prompt: 'You are an agent offering free home valuations, be friendly.',
              first_message: "Hi, I'm Luke from Acme Realty. Would you like a free home valuation today?",
              stream: true
            }));
            req.log.info('✉️ Sent init message to ElevenLabs agent');
          });

          elevenSocket.on('message', data => {
            // ElevenLabs returns raw μ-law 8000Hz PCM
            req.log.info('💬 ElevenLabs → raw audio', { bytes: data.length });
            const audioBase64 = Buffer.from(data).toString('base64');

            // Send back a JSON "media" message to Twilio
            const out = JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: audioBase64 }
            });
            req.log.info('📤 Sending media to Twilio', { length: out.length });
            twilioSocket.send(out);
          });

          elevenSocket.on('error', err => {
            req.log.error(err, '❌ ElevenLabs WebSocket error');
          });

          elevenSocket.on('close', () => {
            req.log.info('✂️ ElevenLabs WebSocket closed — hanging up Twilio');
            // End the call
            const hangup = JSON.stringify({ event: 'stop', streamSid });
            twilioSocket.send(hangup);
            twilioSocket.close();
          });

        } catch (err) {
          req.log.error(err, '❌ Could not open ElevenLabs WebSocket');
          twilioSocket.close();
        }
        break;

      case 'media':
        // Forward only the caller's audio (inbound track) into ElevenLabs
        if (msg.media.track === 'inbound' && elevenSocket?.readyState === WebSocket.OPEN) {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          req.log.info('📥 Forwarding caller audio to ElevenLabs', { bytes: pcm.length });
          elevenSocket.send(pcm);
        } else {
          req.log.info('⚠️ Dropped non-inbound or pre-open media chunk', msg.media.track);
        }
        break;

      case 'stop':
        req.log.info('⏹️ Twilio event: stop — tearing down');
        elevenSocket?.close();
        twilioSocket.close();
        break;

      default:
        req.log.info('ℹ️ Unhandled Twilio event', { event: msg.event });
    }
  });

  twilioSocket.on('close', (code, reason) => {
    req.log.info('🔌 Twilio WebSocket closed', { code, reason });
    elevenSocket?.close();
  });

  twilioSocket.on('error', err => {
    req.log.error(err, '❌ Twilio WebSocket error');
    elevenSocket?.close();
  });
}
