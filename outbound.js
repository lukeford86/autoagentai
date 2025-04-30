import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import Twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
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

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Use the PORT Render provides (or 8000 locally)
const PORT = Number(process.env.PORT) || 8000;
const HOST = "0.0.0.0";

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.statusText}`);
  }
  const data = await response.json();
  return data.signed_url;
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      // TwiML endpoint must be HTTPS and include your Render hostname
      url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({
      success: false,
      error: "Failed to initiate call",
    });
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      ws.on("error", console.error);

      // Establish connection to ElevenLabs
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "you are a gary from the phone store",
                  },
                  first_message:
                    customParameters?.first_message ||
                    "hey there! how can I help you today?",
                },
              },
            };

            console.log(
              "[ElevenLabs] Sending initial config with prompt:",
              initialConfig.conversation_config_override.agent.prompt.prompt
            );

            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);
              // … your switch/case handling …
            } catch (err) {
              console.error("[ElevenLabs] Error processing message:", err);
            }
          });

          elevenLabsWs.on("error", (err) =>
            console.error("[ElevenLabs] WebSocket error:", err)
          );
          elevenLabsWs.on("close", () =>
            console.log("[ElevenLabs] Disconnected")
          );
        } catch (err) {
          console.error("[ElevenLabs] Setup error:", err);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          // … Twilio media handling …
        } catch (err) {
          console.error("[Twilio] Error processing message:", err);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    }
  );
});

// **Bind to 0.0.0.0 so Render can route traffic in**
fastify.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on ${HOST}:${PORT}`);
});
