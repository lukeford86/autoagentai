// twilioHandler.js
import Twilio from 'twilio';
import WebSocket from 'ws';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

// Twilio client & helper
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { twiml: { VoiceResponse } } = Twilio;

// Helper to get the signed URL for your ElevenLabs agent
async function getElevenUrl(log) {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  log.info('Requesting signed ElevenLabs URL', { url });
  const resp = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY }});
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`ElevenLabs URL fetch failed ${resp.status}: ${txt}`);
  }
  const { signed_url } = await resp.json();
  log.info('Received signed ElevenLabs URL');
  return signed_url;
}


/** 1) Place the outbound call with Connect/Stream **/
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host;

  // Build the TwiML
  const vr = new VoiceResponse();
  const connect = vr.connect();
  connect.stream({
    url: `wss://${host}/media-stream`,
    track: 'inbound_track'
  });

  const twimlString = vr.toString();
  req.log.info('Generated TwiML for call', { twiml: twimlString });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml: twimlString
    });
    req.log.info('Call initiated', { callSid: call.sid });
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err, 'Failed to initiate call');
    return reply.status(500).send({ error: 'Call initiation error' });
  }
}


/** 2) Handle the Twilio Media Stream WebSocket **/
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  req.log.info('Twilio WebSocket connection established');

  let elevenSocket;

  twilioSocket.on('message', async (raw) => {
    req.log.info('Raw message from Twilio WS', { length: raw.length });
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return req.log.error(e, 'Failed to JSON.parse Twilio message');
    }
    req.log.info('Parsed Twilio message', msg);

    // 2a) Call answered: Twilio tells us to start streaming
    if (msg.event === 'start') {
      req.log.info('Twilio event "start" received');

      try {
        const wsUrl = await getElevenUrl(req.log);
        req.log.info('Opening ElevenLabs WebSocket', { wsUrl });
        elevenSocket = new WebSocket(wsUrl);

        elevenSocket.on('open', () => {
          req.log.info('ElevenLabs WS open');
          const init = {
            system_prompt: 'You are a real estate agent offering free home valuations. Be polite and concise.',
            first_message: "Hi, I'm Luke from Acme Realty. Would you like a free valuation of your home today?",
            stream: true
          };
          req.log.info('Sending initial prompt to ElevenLabs', init);
          elevenSocket.send(JSON.stringify(init));
        });

        elevenSocket.on('message', (data) => {
          req.log.info('Raw audio from ElevenLabs', { bytes: data.length });
          const b64 = Buffer.from(data).toString('base64');
          const vr2 = new VoiceResponse();
          vr2.play({ url: `data:audio/basic;codec=mulaw;rate=8000;base64,${b64}` });
          const out = vr2.toString();
          req.log.info('Sending TwiML <Play> back to Twilio', { twiml: out });
          twilioSocket.send(out);
        });

        elevenSocket.on('error', (err) => {
          req.log.error(err, 'ElevenLabs WS error');
        });

        elevenSocket.on('close', (code, reason) => {
          req.log.info('ElevenLabs WS closed', { code, reason });
          const vr3 = new VoiceResponse();
          vr3.hangup();
          const hangupTwiML = vr3.toString();
          req.log.info('Sending <Hangup> to Twilio', { twiml: hangupTwiML });
          twilioSocket.send(hangupTwiML);
          twilioSocket.close();
        });

      } catch (err) {
        req.log.error(err, 'Failed to initialize ElevenLabs WS');
        twilioSocket.close();
      }
    }

    // 2b) Caller audio: forward to ElevenLabs
    if (msg.event === 'media') {
      req.log.info('Twilio event "media"', { track: msg.media.track, chunk: msg.media.chunk });
      if (elevenSocket && elevenSocket.readyState === WebSocket.OPEN) {
        const pcm = Buffer.from(msg.media.payload, 'base64');
        req.log.info('Forwarding audio to ElevenLabs', { length: pcm.length });
        elevenSocket.send(pcm);
      } else {
        req.log.warn('ElevenLabs WS not open; dropping caller audio');
      }
    }

    // 2c) Call ended
    if (msg.event === 'stop') {
      req.log.info('Twilio event "stop" received; cleaning up');
      elevenSocket?.close();
      twilioSocket.close();
    }
  });

  twilioSocket.on('close', (code, reason) => {
    req.log.info('Twilio WebSocket closed', { code, reason });
    elevenSocket?.close();
  });

  twilioSocket.on('error', (err) => {
    req.log.error(err, 'Twilio WebSocket error');
    elevenSocket?.close();
  });
}
