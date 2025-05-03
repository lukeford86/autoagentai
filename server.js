import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import { handleCallWebhook, handleMediaStreamSocket } from './twilioHandler.js';

dotenv.config();
const app = Fastify({ logger: true });

app.register(fastifyCors);
app.register(fastifyFormBody);
app.register(fastifyWs);

// 1) HTTP POST → Kick off outbound call with <Connect><Stream>
app.post('/start-call', handleCallWebhook);

// 2) WS Upgrade → Twilio Media Stream proxy
app.get('/media-stream', { websocket: true }, handleMediaStreamSocket);

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' })
   .then(() => app.log.info(`Listening on ${PORT}`));
