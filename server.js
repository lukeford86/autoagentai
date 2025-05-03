import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import { handleCallWebhook, handleMediaStreamSocket } from './twilioHandler.js';

dotenv.config();

const app = Fastify({ logger: true });

// Basic HTTP plugins
app.register(fastifyCors);
app.register(fastifyFormBody);

// WebSocket plugin: accept Twilio’s exact sub-protocol
app.register(fastifyWs, {
  handleProtocols: (protocols, request) => {
    // `protocols` here is an Array<string>
    request.log.info({ protocols }, 'WS sub-protocols offered by client');
    if (protocols.includes('twilio-media-stream')) return 'twilio-media-stream';
    if (protocols.includes('audio'))              return 'audio';
    return false;  // reject others
  }
});

// 1️⃣ Kick off the outbound call
app.post('/start-call', handleCallWebhook);

// 2️⃣ WebSocket handler for the Media Stream
app.get('/media-stream', { websocket: true }, handleMediaStreamSocket);

const PORT = parseInt(process.env.PORT) || 3000;
app.listen({ port: PORT, host: '0.0.0.0' })
   .then(() => app.log.info(`Server listening on port ${PORT}`));
