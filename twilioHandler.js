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

/** Fetch signed URL for your private ElevenLabs agent **/
async function getElevenUrl(log) {
  const uri = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  log.info('⏳ Fetching ElevenLabs signed URL', { uri });
  const res = await fetch(uri, { headers: { 'xi-api-key': ELEVENLABS_API_KEY }});
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ElevenLabs URL fetch failed ${res.status}: ${txt}`);
  }
  const { signed_url } = await res.json();
  log.info('✅ Got ElevenLabs signed URL');
  return signed_url;
}

/** 1) Outbound call with <Connect><Stream> — this *blocks* TwiML so the call stays alive **/
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host   = req.headers.host; 

  // Build blocking TwiML
  const vr      = new VoiceResponse();
  const connect = vr.connect();
  connect.stream({ url: `wss://${host}/media-stream` });
  // nothing after Connect—this verb never returns control to Twilio

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

/** 2) Proxy WebSocket between Twilio and ElevenLabs **/
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  req.log.info('🔌 Twilio WS connected', {
    protocol: req.headers['sec-websocket-protocol']
  });

  let elevenSocket, streamSid;

  twilioSocket.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return req.log.error(e, '❌ Could not JSON.parse Twilio message');
    }
    req.log.info('💬 Twilio →', msg);

    switch (msg.event) {
      case 'connected':
        req.log.info('✅ Twilio event "connected"');
        break;

      case 'start':
        streamSid = msg.start.streamSid;
        req.log.info('▶️ Twilio event "start"', {
          streamSid,
          tracks: msg.start.tracks
        });

        // Open ElevenLabs WS
        try {
          const wsUrl = await getElevenUrl(req.log);
          req.log.info('🔌 Opening ElevenLabs WS', { wsUrl });
          elevenSocket = new WebSocket(wsUrl);

          elevenSocket.on('open', () => {
            req.log.info('🗨️ ElevenLabs WS open — sending init prompt');
            elevenSocket.send(JSON.stringify({
              system_prompt: 'You are a friendly RE agent offering free home valuations.',
              first_message: "Hi, I'm Luke from Acme Realty. Would you like a free home valuation today?",
              stream: true
            }));
          });

          elevenSocket.on('message', data => {
            req.log.info('🗨️ ElevenLabs → audio chunk', { bytes: data.length });
            const payload = Buffer.from(data).toString('base64');
            const out = JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload }
            });
            req.log.info('📤 Sending media → Twilio', { bytes: out.length });
            twilioSocket.send(out);
          });

          elevenSocket.on('error', err => {
            req.log.error(err, '❌ ElevenLabs WS error');
          });

          elevenSocket.on('close', (code, reason) => {
            req.log.info('✂️ ElevenLabs WS closed', { code, reason });
            // Tell Twilio to stop & hang up
            const stopMsg = JSON.stringify({ event: 'stop', streamSid });
            twilioSocket.send(stopMsg);
            twilioSocket.close();
          });

        } catch (err) {
          req.log.error(err, '❌ Opening ElevenLabs WS failed');
          twilioSocket.close();
        }
        break;

      case 'media':
        // Forward **only** the inbound audio frames from the prospect
        if (msg.media.track === 'inbound') {
          const pcm = Buffer.from(msg.media.payload, 'base64');
          req.log.info('📥 Forwarding caller audio → ElevenLabs', { bytes: pcm.length });
          if (elevenSocket?.readyState === WebSocket.OPEN) {
            elevenSocket.send(pcm);
          }
        }
        break;

      case 'stop':
        req.log.info('⏹️ Twilio event "stop" — tearing down');
        elevenSocket?.close();
        twilioSocket.close();
        break;

      default:
        req.log.info('ℹ️ Unhandled Twilio event', { event: msg.event });
    }
  });

  twilioSocket.on('close', (code, reason) => {
    req.log.info('🔌 Twilio WS closed', { code, reason });
    elevenSocket?.close();
  });

  twilioSocket.on('error', err => {
    req.log.error(err, '❌ Twilio WS error');
    elevenSocket?.close();
  });
}
