import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import twilio from "twilio";

// Load environment variables from .env file
dotenv.config();

const {
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SERVER_DOMAIN,
  PORT = process.env.PORT || 3000,
  HOST = '0.0.0.0' // Required for Render.com
} = process.env;

// Check for the required environment variables
if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error(
    "Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in environment variables"
  );
  process.exit(1);
}

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing Twilio environment variables");
  process.exit(1);
}

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Fastify server
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs, {
  options: {
    maxPayload: 1048576, // 1MB max payload
    pingInterval: 30000, // Keep connections alive
  }
});

// Helper function to get proper server URL
function getServerUrl(request) {
  // Prefer the configured SERVER_DOMAIN if available
  if (SERVER_DOMAIN) {
    return SERVER_DOMAIN;
  }
  
  // Otherwise use the request hostname
  return request.headers.host;
}

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({
    message: "Server is running",
    version: "1.0.0",
    endpoints: ["/health", "/twilio/inbound_call", "/outbound-call"]
  });
});

// Health check endpoint
fastify.get("/health", async (_, reply) => {
  reply.send({ 
    status: "ok", 
    timestamp: new Date().toISOString() 
  });
});

// Route to handle incoming calls from Twilio
fastify.all("/twilio/inbound_call", async (request, reply) => {
  const hostname = getServerUrl(request);
  const protocol = hostname.includes('localhost') ? 'ws' : 'wss';
  const streamUrl = `${protocol}://${hostname}/media-stream`;
  
  console.log(`🧭 Generated stream URL: ${streamUrl}`);

  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
  <Pause length="300" />
</Response>`;

  console.log('📤 Sending TwiML response');
  reply.type("text/xml").send(twimlResponse);
});

// Outbound call trigger
fastify.post("/outbound-call", async (request, reply) => {
  const { phoneNumber } = request.body;
  
  if (!phoneNumber) {
    return reply.status(400).send({ error: 'Phone number is required' });
  }
  
  console.log(`📞 Outbound call requested to ${phoneNumber}`);

  try {
    const hostname = getServerUrl(request);
    const protocol = hostname.includes('localhost') ? 'http' : 'https';
    const twimlUrl = `${protocol}://${hostname}/twilio/inbound_call`;
    console.log(`📡 TwiML URL: ${twimlUrl}`);

    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_PHONE_NUMBER,
      url: twimlUrl,
      statusCallback: `${protocol}://${hostname}/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    
    console.log(`✅ Twilio call initiated. SID: ${call.sid}`);
    return { status: 'ok', sid: call.sid };
  } catch (err) {
    console.error(`❌ Failed to create Twilio call: ${err.message}`);
    reply.status(500).send({ error: err.message });
  }
});

// Call status webhook
fastify.post("/call-status", async (request, reply) => {
  const { CallSid, CallStatus } = request.body;
  console.log(`📊 Call ${CallSid} status: ${CallStatus}`);
  return { received: true };
});

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
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
      throw new Error(`Failed to get signed URL: ${response.statusText} (${response.status})`);
    }

    const data = await response.json();
    console.log('✅ Successfully obtained signed URL');
    return data.signed_url;
  } catch (error) {
    console.error("❌ Error getting signed URL:", error);
    throw error;
  }
}

// WebSocket route for handling media streams
fastify.register(async fastifyInstance => {
  fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
    console.info("🔌 Twilio connected to media stream");

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null;

    // Handle WebSocket errors
    ws.on("error", error => {
      console.error(`❌ Twilio WebSocket error: ${error.message}`);
    });

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        console.log('📡 Getting signed URL from ElevenLabs...');
        const signedUrl = await getSignedUrl();
        console.log(`📡 Connecting to ElevenLabs with signed URL...`);
        
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("✅ Connected to ElevenLabs Conversational AI");
        });

        elevenLabsWs.on("message", data => {
          try {
            // Try to parse as JSON
            let message;
            try {
              message = JSON.parse(data);
            } catch (e) {
              // Not JSON, might be binary data
              console.log(`📥 Received non-JSON data from ElevenLabs: ${data.length} bytes`);
              return;
            }

            switch (message.type) {
              case "conversation_initiation_metadata":
                console.log("📄 Received initiation metadata from ElevenLabs");
                break;

              case "audio":
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                    console.log(`📤 Sent audio chunk to Twilio: ${message.audio.chunk.length} bytes`);
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                    console.log(`📤 Sent audio (base64) to Twilio: ${message.audio_event.audio_base_64.length} bytes`);
                  }
                } else {
                  console.log("⚠️ Received audio from ElevenLabs but no StreamSid yet");
                }
                break;

              case "interruption":
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: "clear",
                      streamSid,
                    })
                  );
                  console.log("🔇 Sent clear event to Twilio (interruption)");
                }
                break;

              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id,
                    })
                  );
                  console.log(`📡 Sent pong response to ElevenLabs ping`);
                }
                break;

              case "agent_response":
                console.log(
                  `📝 Agent response: ${message.agent_response_event?.agent_response}`
                );
                break;

              case "user_transcript":
                console.log(
                  `🎤 User transcript: ${message.user_transcription_event?.user_transcript}`
                );
                break;

              default:
                console.log(
                  `ℹ️ Unhandled message type from ElevenLabs: ${message.type}`
                );
            }
          } catch (error) {
            console.error(`❌ Error processing ElevenLabs message: ${error.message}`);
          }
        });

        elevenLabsWs.on("error", error => {
          console.error(`❌ ElevenLabs WebSocket error: ${error.message}`);
        });

        elevenLabsWs.on("close", (code, reason) => {
          console.log(`🔌 ElevenLabs disconnected: ${code} - ${reason || 'No reason provided'}`);
        });
      } catch (error) {
        console.error(`❌ ElevenLabs setup error: ${error.message}`);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on("message", message => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log(`📥 Received event from Twilio: ${msg.event}`);
        }

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            console.log(
              `🎬 Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
            );
            break;

          case "media":
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(
                  msg.media.payload,
                  "base64"
                ).toString("base64"),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
              // Don't log every media packet to avoid flooding logs
            }
            break;

          case "stop":
            console.log(`🛑 Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`ℹ️ Unhandled event from Twilio: ${msg.event}`);
        }
      } catch (error) {
        console.error(`❌ Error processing Twilio message: ${error.message}`);
      }
    });

    // Handle WebSocket closure
    ws.on("close", () => {
      console.log("🔌 Twilio client disconnected");
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start the Fastify server
fastify.listen({ port: Number(PORT), host: HOST }, err => {
  if (err) {
    console.error(`❌ Error starting server: ${err.message}`);
    process.exit(1);
  }
  console.log(`🚀 Server listening on ${HOST}:${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🤖 Using ElevenLabs Agent ID: ${ELEVENLABS_AGENT_ID}`);
});

// Graceful shutdown
const shutdown = () => {
  console.log('🛑 Shutting down server...');
  fastify.close(() => {
    console.log('✅ Server shutdown complete');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
