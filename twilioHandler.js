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

// Fetch a signed URL for your ElevenLabs agent
async function getElevenUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY } });
  if (!res.ok) throw new Error(`ElevenLabs URL error: ${res.status}`);
  const { signed_url } = await res.json();
  return signed_url;
}

/** 1) Outbound call via Twilio with Connect/Stream **/
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host;

  const response = new VoiceResponse();
  // <Connect><Stream url="wss://.../media-stream" track="inbound_track"/></Connect>
  const connect = response.connect();
  connect.stream({ url: `wss://${host}/media-stream`, track: 'inbound_track' });

  req.log.info({ to }, 'Starting call with Connect/Stream');
  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml: response.toString()
    });
    req.log.info({ callSid: call.sid }, 'Call initiated');
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err, 'Call initiation failed');
    return reply.status(500).send({ error: 'Failed to start call' });
  }
}

/** 2) WebSocket handler: proxy Twilio <-> ElevenLabs **/
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  req.log.info('Twilio WebSocket connection established');

  let elevenSocket;

  twilioSocket.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { return req.log.error(e, 'Invalid JSON from Twilio'); }

    req.log.info({ event: msg.event }, 'Twilio event received');

    // On 'start', spin up ElevenLabs WS
    if (msg.event === 'start') {
      try {
        const wsUrl = await getElevenUrl();
        req.log.info({ wsUrl }, 'Opening ElevenLabs WebSocket');
        elevenSocket = new WebSocket(wsUrl);

        elevenSocket.on('open', () => {
          req.log.info('ElevenLabs WebSocket open');
          // Inject your first agent prompt
          elevenSocket.send(JSON.stringify({
            system_prompt: "You are a real estate agent offering free home valuations. Be polite and concise.",
            first_message: "Hi, I'm Luke from Acme Realty. Would you like a free valuation of your home today?",
            stream: true
          }));
        });

        elevenSocket.on('message', data => {
          req.log.info({ bytes: data.length }, 'Received audio from ElevenLabs');
          const audioBase64 = Buffer.from(data).toString('base64');
          const vr = new VoiceResponse();
          vr.play({
            url: `data:audio/basic;codec=mulaw;rate=8000;base64,${audioBase64}`
          });
          twilioSocket.send(vr.toString());
        });

        elevenSocket.on('error', err => {
          req.log.error(err, 'ElevenLabs WebSocket error');
        });

        elevenSocket.on('close', () => {
          req.log.info('ElevenLabs WebSocket closed, hanging up');
          const vr = new VoiceResponse();
          vr.hangup();
          twilioSocket.send(vr.toString());
          twilioSocket.close();
        });
      } catch (err) {
        req.log.error(err, 'Failed to initialize ElevenLabs WebSocket');
        twilioSocket.close();
      }
    }

    // On 'media', forward caller audio into ElevenLabs
    if (msg.event === 'media' && elevenSocket?.readyState === WebSocket.OPEN) {
      const pcm = Buffer.from(msg.media.payload, 'base64');
      elevenSocket.send(pcm);
      req.log.info({ size: pcm.length }, 'Forwarded caller audio to agent');
    }

    // On 'stop', tear everything down
    if (msg.event === 'stop') {
      req.log.info('Twilio stream stopped by Twilio');
      elevenSocket?.close();
      twilioSocket.close();
    }
  });

  twilioSocket.on('close', code => {
    req.log.info({ code }, 'Twilio WebSocket closed');
    elevenSocket?.close();
  });

  twilioSocket.on('error', err => {
    req.log.error(err, 'Twilio WebSocket error');
    elevenSocket?.close();
  });
}
