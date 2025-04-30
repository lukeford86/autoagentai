import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Use Render’s $PORT (fallback to 8000 locally) and bind on 0.0.0.0
const PORT = Number(process.env.PORT) || 8000;
const HOST = "0.0.0.0";

fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function getSignedUrl() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      method: "GET",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.statusText}`);
  }
  const data = await response.json();
  return data.signed_url;
}

// ─── Outbound Call Route ───────────────────────────────────────────────────────
fastify.post("/outbound-call", async (request, reply) => {
  // Destructure with defaults
  const {
    number,
    prompt = "",
    first_message = "",
  } = request.body as Record<string, string>;

  // Validate
  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }
  if (!prompt) {
    return reply.code(400).send({ error: "Prompt is required" });
  }

  // Log exactly what you got
  console.log("[Outbound] Params:", { number, prompt, first_message });

  // Build TwiML URL
  const twimlUrl = `https://${request.headers.host}/outbound-call-twiml?` +
    `prompt=${encodeURIComponent(prompt)}` +
    `&first_message=${encodeURIComponent(first_message)}`;

  console.log("[Outbound] TwiML URL:", twimlUrl);

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: twimlUrl,
    });
    console.log("[Twilio] Call initiated, SID:", call.sid);
    return reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });

  } catch (err: any) {
    // Log full error object
    console.error("Error initiating outbound call:", err);

    // Unwrap Twilio RestError if present
    const status = err.status || 500;
    const payload = {
      success: false,
      error: err.message || "Unknown error",
      code: err.code || null,
      moreInfo: err.moreInfo || err,
    };

    return reply.code(status).send(payload);
  }
});

// ─── TwiML Route ───────────────────────────────────────────────────────────────
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt        = request.query.prompt        || "";
  const first_message = request.query.first_message || "";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Connect>
      <Stream url="wss://${request.headers.host}/outbound-media-stream">
        <Parameter name="prompt"       value="${prompt}" />
        <Parameter name="first_message" value="${first_message}" />
      </Stream>
    </Connect>
  </Response>`;

  reply.type("text/xml").send(twiml);
});

// ─── WebSocket Media Streaming ─────────────────────────────────────────────────
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");
      // … your existing WebSocket handler …
    }
  );
});

// ─── Start server ──────────────────────────────────────────────────────────────
fastify.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on ${HOST}:${PORT}`);
});
