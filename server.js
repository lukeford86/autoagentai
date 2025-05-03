import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import { handleCallWebhook, handleMediaStreamSocket } from './twilioHandler.js';

dotenv.config();
const app = Fastify({ logger: true });

// register CORS + formbody
app.register(fastifyCors);
app.register(fastifyFormBody);

// register WebSocket but accept Twilio’s sub‐protocol
app.register(fastifyWs, {
  handleProtocols: (protocols, req) => {
    const offered = Object.keys(protocols);
    req.log.info({ offered }, 'WebSocket protocols offered by client');
    // Twilio Media Streams uses protocol “twilio-media-stream”
    if (protocols['twilio-media-stream']) return 'twilio-media-stream';
    // some samples mention “audio”
    if (protocols['audio']) return 'audio';
    return false;
  }
});

// 1) Kick off the call
app.post('/start-call', handleCallWebhook);

// 2) Media WS
app.get('/media-stream', { websocket: true }, handleMediaStreamSocket);

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' })
   .then(() => app.log.info(`Listening on ${PORT}`));
