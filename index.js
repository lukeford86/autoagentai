// index.js
const fastify = require('fastify')();

fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/websocket'));

// POST endpoint for triggering outbound call
fastify.post('/outbound-call', async (req, reply) => {
  console.log('✅ POST /outbound-call received');
  console.log('📞 Body:', req.body);

  const { phoneNumber, prompt, firstMessage } = req.body;

  // For now, just echo the values
  reply.send({
    status: 'ok',
    message: 'Call received',
    phoneNumber,
    prompt,
    firstMessage
  });
});

// Default route to confirm the server works
fastify.get('/', async (req, reply) => {
  reply.send({ status: 'ok', message: 'Auto Agent AI Server Live!' });
});

// Start the server
fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`🚀 Server running at ${address}`);
});
