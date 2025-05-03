import Twilio from 'twilio';
import WebSocket from 'ws';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID
} = process.env;

// Twilio helper
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const { twiml: { VoiceResponse } } = Twilio;

/**
 * 1) Initiate an outbound call via Twilio, and tell Twilio
 *    “open a Media Stream at /media-stream and let me drive the audio.”
 */
export async function handleCallWebhook(req, reply) {
  const { to } = req.body;
  const host = req.headers.host; // e.g. "myapp.herokuapp.com"

  const response = new VoiceResponse();
  response.start().stream({ url: `wss://${host}/media-stream` });

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
 * 2) For each incoming Twilio stream, open a matching ElevenLabs
 *    conversational WebSocket and proxy audio both ways.
 */
export async function handleMediaStreamSocket(connection, req) {
  const twilioSocket = connection.socket;
  let elevenSocket;

  // Optionally: fetch a signed URL if your agent is private
  async function getElevenUrl() {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
      throw new Error('Missing ElevenLabs credentials');
    }
    const url = `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`;
    const res = await fetch(url, {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });
    if (!res.ok) throw new Error('Could not get signed URL');
    const body = await res.json();
    return body.signed_url;
  }

  twilioSocket.on('message', async raw => {
    const msg = JSON.parse(raw.toString());

    // When Twilio opens the audio stream, spin up the ElevenLabs WS
    if (msg.event === 'start') {
      try {
        const wsUrl = await getElevenUrl();
        elevenSocket = new WebSocket(wsUrl);

        elevenSocket.on('open', () => {
          // Kick off the conversation with your agent’s first prompt:
          const init = {
            system_prompt: "You are calling about a free property valuation request. Be friendly and concise.",
            first_message: "Hi, this is Luke from Acme Realty. Are you interested in a free home valuation?",
            stream: true
          };
          elevenSocket.send(JSON.stringify(init));
        });

        // When ElevenLabs returns audio chunks, play them into Twilio:
        elevenSocket.on('message', data => {
          // data is raw binary audio (μ-law 8000 Hz frames)
          const audioBase64 = Buffer.from(data).toString('base64');
          const vr = new VoiceResponse();
          vr.play({ url: `data:audio/basic;codec=mulaw;rate=8000,${audioBase64}` });
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

    // Forward caller’s speech into the agent:
    if (msg.event === 'media' && elevenSocket && elevenSocket.readyState === WebSocket.OPEN) {
      const pcm = Buffer.from(msg.media.payload, 'base64');
      elevenSocket.send(pcm);
    }

    // Clean up on call-end
    if (msg.event === 'stop') {
      elevenSocket?.close();
      twilioSocket.close();
    }
  });

  twilioSocket.on('close', () => {
    req.log.info('Twilio Media Stream closed');
    elevenSocket?.close();
  });
}
