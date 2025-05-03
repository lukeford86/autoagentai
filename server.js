import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyCors from '@fastify/cors';
import { handleCallWebhook, handleMediaStream } from './twilioHandler.js';

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyCors);

fastify.post('/start-call', handleCallWebhook); // Initiated from n8n
fastify.post('/media-stream', handleMediaStream); // Twilio streams call audio here

const start = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
    console.log('Server running');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();