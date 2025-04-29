// server.js
require("dotenv").config();

const express        = require("express");
const bodyParser     = require("body-parser");
const { twiml: { VoiceResponse } } = require("twilio");
const { Deepgram }   = require("@deepgram/sdk");
const { OpenAI }     = require("openai");
const WebSocket      = require("ws");

// —— ElevenLabs import fix ——
const elevenModule  = require("elevenlabs");
const ElevenLabsAPI = elevenModule.default || elevenModule;
const eleven        = new ElevenLabsAPI({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 10000;

// 1) TwiML webhook to hand off to Media Streams
app.post("/twiml", (req, res) => {
  const { agent_id, voice_id, contact_name, address } = req.query;
  console.log("[TwiML] Received query params:", { agent_id, voice_id, contact_name, address });

  const vr = new VoiceResponse();
  const connect = vr.connect();
  connect.stream({
    url: `wss://${req.headers.host}/media`,
    track: "inbound",
    parameters: { agent_id, voice_id, contact_name, address }
  });

  res.type("text/xml").send(vr.toString());
});

// 2) Spin up HTTP + WS server
const server = app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
const wss = new WebSocket.Server({ server, path: "/media" });

// 3) Clients for Deepgram & OpenAI
const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
const openai   = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY });

wss.on("connection", (ws) => {
  console.log("[WS] Twilio stream opened, waiting for start event…");

  // Buffer to hold the Twilio-sent customParameters
  let params = {};

  // Kick off a live Deepgram transcription socket
  const dgSocket = deepgram.transcription.live({
    encoding:    "mulaw",
    sampleRate:  8000,
    channels:    1,
    interimResults: true
  });
  dgSocket.open();

  dgSocket.addListener("open", () => {
    console.log("[Deepgram] transcription socket open");
  });

  // When Deepgram returns results…
  dgSocket.addListener("transcriptReceived", async (trans) => {
    const text = trans.channel.alternatives[0].transcript.trim();
    console.log("[Deepgram]", trans.isFinal ? "final →" : "interim →", text);

    if (trans.isFinal && text) {
      // 4) Send the user’s words to OpenAI (via OpenRouter)
      const aiRes = await openai.chat.completions.create({
        model:    "gpt-4o-mini",
        messages: [
          {
            role:    "system",
            content: "You are an appointment reminder agent."
          },
          {
            role:    "user",
            content: `Customer said: "${text}". Respond appropriately.`
          }
        ]
      });
      const reply = aiRes.choices[0].message.content.trim();
      console.log("[AI reply]", reply);

      // 5) Text-to-speech via ElevenLabs
      const audioBuffer = await eleven.textToSpeech({
        text:  reply,
        voice: params.voice_id
      });
      console.log("[TTS] audio byte length:", audioBuffer.length);

      // 6) Push that audio back to Twilio via REST <Play>
      //    (You could also stream it back over MediaStream, but easiest is REST)
      const twilioClient = require("twilio")(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      await twilioClient.calls(params.callSid)
        .update({
          twiml: `<Response><Play>data:audio/wav;base64,${audioBuffer.toString("base64")}</Play></Response>`
        });
    }
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.event === "start") {
      // grabs our customParameters into a local var
      params = msg.start.customParameters;
      console.log("[WS start] customParameters:", params);
    }
    else if (msg.event === "media") {
      // Twilio streaming us raw PCM; feed it to Deepgram
      const pcm = Buffer.from(msg.media.payload, "base64");
      dgSocket.send(pcm);
      console.log("📡 got media chunk:", msg.media.chunk);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Twilio disconnected");
    dgSocket.finish();       // close Deepgram
  });
});
