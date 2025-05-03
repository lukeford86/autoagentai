import Twilio from 'twilio';
import WebSocket from 'ws';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

// Twilio helper & client
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { twiml: { VoiceResponse } } = Twilio;

// Helper to fetch a signed URL for your private agent
async function getElevenUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
  const res = await fetch(url, { headers: { 'xi-api-key': ELEVENLABS_API_KEY }});
  if (!res.ok) throw new Error('Could not get signed ElevenLabs URL');
  const { signed_url } = await res.json();
  return signed_url;
}

/**
 * 1) Initiate an outbound call via Twilio,
 *    using <Connect><Stream> for bidirectional audio.
 */
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host;

  const response = new VoiceResponse();
  const connect = response.connect();
  connect.stream({ url: `wss://${host}/media-stream` });

  try {
    const call = await client.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      twiml: response.toString()
    });
    return reply.send({ callSid: call.sid });
  } catch (err) {
    req.log.error(err);
    return reply.status(500).send({ error: 'Failed to start call' });
  }
}

/**
 * 2) WebSocket handler for Twilio Media Streams:
 *    - On 'start' → open ElevenLabs WS
 *    - On 'media' → proxy prospect audio into ElevenLabs
 *    - On ElevenLabs 'message' → play agent audio back via Twilio
 *    - On 'stop' or close → hang up
 */
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  let elevenSocket;

  twilioSocket.on('message', async raw => {
    const msg = JSON.parse(raw.toString());

    // Prospect picked up: build ElevenLabs connection
    if (msg.event === 'start') {
      try {
        const wsUrl = await getElevenUrl();
        elevenSocket = new WebSocket(wsUrl);

        elevenSocket.on('open', () => {
          // Kick off the agent’s first line
          const init = {
            system_prompt: "You are a real estate agent offering free home valuations. Be polite and concise.",
            first_message: "Hi there, I'm Luke from Acme Realty. Would you like a free valuation of your home today?",
            stream: true
          };
          elevenSocket.send(JSON.stringify(init));
        });

        elevenSocket.on('message', data => {
          // data arrives as raw μ-law PCM frames
          const audioBase64 = Buffer.from(data).toString('base64');
          const vr = new VoiceResponse();
          vr.play({ url: `data:audio/basic;codec=mulaw;rate=8000;base64,${audioBase64}` });
          twilioSocket.send(vr.toString());
        });

        elevenSocket.on('close', () => {
          const vr = new VoiceResponse();
          vr.hangup();
          twilioSocket.send(vr.toString());
          twilioSocket.close();
        });

      } catch (err) {
        req.log.error('ElevenLabs init error:', err);
        twilioSocket.close();
      }
    }

    // Forward caller speech into the agent
    if (msg.event === 'media' && elevenSocket?.readyState === WebSocket.OPEN) {
      const pcm = Buffer.from(msg.media.payload, 'base64');
      elevenSocket.send(pcm);
    }

    // Clean up on call end
    if (msg.event === 'stop') {
      elevenSocket?.close();
      twilioSocket.close();
    }
  });

  twilioSocket.on('close', () => {
    req.log.info('Twilio WebSocket closed');
    elevenSocket?.close();
  });
}
