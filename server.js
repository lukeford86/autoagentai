import Fastify from 'fastify';

const app = Fastify();

app.get('/test', (req, reply) => reply.send({ status: 'test ok' }));

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Minimal Fastify server listening on ${address}`);
});
