// server.js
import Fastify from 'fastify';
import http from 'http';
import { WebSocketServer } from 'ws';
import fastifyCors from '@fastify/cors';
import fastifyFormBody from '@fastify/formbody';
import dotenv from 'dotenv';
import { handleCallWebhook, handleMediaStreamSocket } from './twilioHandler.js';

dotenv.config();

// 1️⃣ Create Fastify & HTTP server
const app    = Fastify({ logger: true });
const server = http.createServer(app.handler);

// 2️⃣ Attach a raw ws server for /media-stream
const wss = new WebSocketServer({
  server,
  path: '/media-stream',
  handleProtocols: (offeredProtocols, request) => {
    // Twilio will offer ['twilio-media-stream'] (or sometimes ['audio'])
    request.log.info({ offeredProtocols }, 'WS subprotocols offered');
    if (offeredProtocols.includes('twilio-media-stream')) return 'twilio-media-stream';
    if (offeredProtocols.includes('audio'))              return 'audio';
    return false; // reject
  }
});

// 3️⃣ On each WS connection, hand off to your handler
wss.on('connection', (socket, request) => {
  handleMediaStreamSocket(socket, request, app.log);
});

// 4️⃣ Register REST endpoint on Fastify
app.register(fastifyCors);
app.register(fastifyFormBody);
app.post('/start-call', handleCallWebhook);

// 5️⃣ Start listening
const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  app.log.info(`HTTP+WS Server listening on port ${PORT}`);
});
