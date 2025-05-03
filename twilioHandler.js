import Twilio from 'twilio';
import https from 'https';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID
} = process.env;

// Grab VoiceResponse from the official twilio package
const { twiml: { VoiceResponse } } = Twilio;
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/** 1) Initiate the outbound call and open a media stream **/
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host; // to build WS URL

  const twiml = `<Response>
                   <Start>
                     <Stream url="wss://${host}/media-stream"/>
                   </Start>
                 </Response>`;

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml
    });
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Call failed' });
  }
}

/** 2) WebSocket handler for Twilio Media Streams **/
export function handleMediaStreamSocket(connection, req) {
  const socket = connection.socket;
  let first = true;

  socket.on('message', async (raw) => {
    const msg = JSON.parse(raw.toString());

    // When Twilio opens the stream, send your first TTS chunk
    if (msg.event === 'start' && first) {
      first = false;
      streamElevenLabsAudio(
        socket,
        "Hi, I'm calling on behalf of your agent. Would you be interested in a free property valuation?"
      );
    }

    // You can also inspect `msg.event === 'media'` to transcribe or react to the callee.
  });

  socket.on('close', () => req.log.info('Media WS closed'));
}

/** 3) Fetch ElevenLabs TTS and forward as VoiceResponse <Play> frames **/
function streamElevenLabsAudio(socket, text) {
  const opts = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    }
  };

  const req = https.request(opts, (res) => {
    res.on('data', (chunk) => {
      const base64 = chunk.toString('base64');
      const vr = new VoiceResponse();
      vr.play({ url: `data:audio/mpeg;base64,${base64}` });
      socket.send(vr.toString());
    });

    res.on('end', () => {
      const vr = new VoiceResponse();
      vr.hangup();
      socket.send(vr.toString());
      socket.close();
    });
  });

  req.on('error', (err) => {
    console.error('ElevenLabs stream error:', err);
    socket.close();
  });

  req.write(JSON.stringify({
    text,
    model_id: 'eleven_monolingual_v1',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
  }));
  req.end();
}
