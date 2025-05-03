import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import { handleCallWebhook, handleMediaStreamSocket } from './twilioHandler.js';

dotenv.config();
const app = Fastify({ logger: true });

// CORS & body parsing
app.register(fastifyCors);
app.register(fastifyFormBody);

// WebSocket plugin: explicitly accept Twilio’s media‐stream protocol
app.register(fastifyWs, {
  handleProtocols: (protocols, req) => {
    req.log.info({ offered: Object.keys(protocols) }, 'WS subprotocols offered');
    if (protocols['twilio-media-stream']) return 'twilio-media-stream';
    if (protocols['audio']) return 'audio';
    return false;
  }
});

// 1️⃣ HTTP to kick off the call
app.post('/start-call', handleCallWebhook);

// 2️⃣ WS upgrade for media streaming
app.get('/media-stream', { websocket: true }, handleMediaStreamSocket);

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' })
   .then(() => app.log.info(`Server listening on port ${PORT}`));
