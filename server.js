import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { handleCallWebhook, handleMediaStreamSocket } from './twilioHandler.js';
import dotenv from 'dotenv';

dotenv.config();

const app = Fastify({ logger: true });

// register plugins
app.register(fastifyCors);
app.register(fastifyFormBody);
app.register(fastifyWs);

// HTTP endpoint to kick off the call
app.post('/start-call', handleCallWebhook);

// WebSocket endpoint for Twilio Media Streams
app.get('/media-stream', { websocket: true }, handleMediaStreamSocket);

// start server
const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' })
   .then(() => app.log.info(`Listening on ${PORT}`));
