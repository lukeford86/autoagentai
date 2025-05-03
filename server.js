// server.js
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

// 1) Kick off the call
app.post('/start-call', async (req, reply) => {
  req.log.info('POST /start-call', { body: req.body });
  const res = await handleCallWebhook(req, reply);
  req.log.info('POST /start-call done');
  return res;
});

// 2) WebSocket for Twilio media
app.get('/media-stream', { websocket: true }, (conn, req) => {
  req.log.info('GET /media-stream (WS upgrade)');
  return handleMediaStreamSocket(conn, req);
});

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' })
   .then(() => app.log.info(`Listening on ${PORT}`));
