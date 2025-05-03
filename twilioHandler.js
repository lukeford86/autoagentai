import Twilio from 'twilio';
import { WebSocket } from 'ws';
import { getElevenLabsStream } from './elevenLabsClient.js';

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;
const client = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

export async function handleCallWebhook(request, reply) {
  const { to, voicePrompt } = request.body;

  try {
    const call = await client.calls.create({
      twiml: `<Response><Start><Stream url="wss://your-server-domain.com/media-stream" /></Start><Say>${voicePrompt}</Say></Response>`,
      to,
      from: TWILIO_PHONE_NUMBER,
    });

    reply.send({ status: 'calling', callSid: call.sid });
  } catch (error) {
    console.error('Call error:', error);
    reply.status(500).send({ error: 'Call failed' });
  }
}

export async function handleMediaStream(request, reply) {
  const ws = new WebSocket(request.body.StreamSid);
  ws.on('open', () => {
    console.log('Twilio stream connected');
    getElevenLabsStream(ws); // Stream ElevenLabs output to Twilio
  });

  ws.on('message', (msg) => {
    console.log('Twilio said:', msg.toString());
  });

  ws.on('close', () => {
    console.log('Twilio stream closed');
  });

  reply.send({ status: 'stream connected' });
}