diff --git a/server.js b/server.js
index abcdef1..abcdef2 100644
--- a/server.js
+++ b/server.js
@@ -1,6 +1,9 @@
 import Fastify from 'fastify';
 import http from 'http';
 import { WebSocketServer } from 'ws';
+import path from 'path';
+import fs from 'fs';
 import fastifyCors from '@fastify/cors';
 import fastifyFormBody from '@fastify/formbody';
 import dotenv from 'dotenv';
 
+// ------------------ Health and Binding Fix ------------------
 // create Fastify & raw HTTP server
 const app    = Fastify({ logger: true });
 const server = http.createServer(app.handler);
+
+// simple health check so Render sees a 200 on GET /
+app.get('/', (req, reply) => reply.send({ status: 'ok' }));
+app.head('/', (req, reply) => reply.send());
+// -------------------------------------------------------------
 
 // attach ws server on the same underlying server
 const wss = new WebSocketServer({
@@ -47,7 +50,7 @@ server.listen(PORT, () => {
   app.log.info(`HTTP+WS Server listening on port ${PORT}`);
 });
