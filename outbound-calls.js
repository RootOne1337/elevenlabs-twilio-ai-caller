import WebSocket from "ws";
import Twilio from "twilio";
import fetch from "node-fetch";

export function registerOutboundRoutes(fastify) {
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

  // Инициализируем клиент Twilio
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Функция для получения подписанного URL от ElevenLabs
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: "GET",
          headers: { "xi-api-key": ELEVENLABS_API_KEY },
        },
      );
      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }
      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // Роут для инициирования исходящего звонка
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, prompt } = request.body;
    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }
    try {
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt)}`,
      });
      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid,
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply
        .code(500)
        .send({ success: false, error: "Failed to initiate call" });
    }
  });

  // TwiML-роут для исходящего звонка
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const prompt = request.query.prompt || "";
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
          </Stream>
        </Connect>
      </Response>`;
    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket-роут для исходящего медиа-потока
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

        async function setupElevenLabs() {
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
                    first_message: "hey there! how can I help you today?",
                  },
                },
              };
              console.log(
                "[ElevenLabs] Sending initial config with prompt:",
                initialConfig.conversation_config_override.agent.prompt.prompt,
              );
              elevenLabsWs.send(JSON.stringify(initialConfig));
            });

            elevenLabsWs.on("message", (data) => {
              try {
                const message = JSON.parse(data);
                switch (message.type) {
                  case "conversation_initiation_metadata":
                    console.log("[ElevenLabs] Received initiation metadata");
                    break;
                  case "audio":
                    if (streamSid) {
                      if (message.audio?.chunk) {
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: { payload: message.audio.chunk },
                        };
                        ws.send(JSON.stringify(audioData));
                      } else if (message.audio_event?.audio_base_64) {
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: { payload: message.audio_event.audio_base_64 },
                        };
                        ws.send(JSON.stringify(audioData));
                      }
                    } else {
                      console.log(
                        "[ElevenLabs] Received audio but no StreamSid yet",
                      );
                    }
                    break;
                  case "interruption":
                    if (streamSid) {
                      ws.send(JSON.stringify({ event: "clear", streamSid }));
                    }
                    break;
                  case "ping":
                    if (message.ping_event?.event_id) {
                      elevenLabsWs.send(
                        JSON.stringify({
                          type: "pong",
                          event_id: message.ping_event.event_id,
                        }),
                      );
                    }
                    break;
                  default:
                    console.log(
                      `[ElevenLabs] Unhandled message type: ${message.type}`,
                    );
                }
              } catch (error) {
                console.error("[ElevenLabs] Error processing message:", error);
              }
            });

            elevenLabsWs.on("error", (error) => {
              console.error("[ElevenLabs] WebSocket error:", error);
            });
            elevenLabsWs.on("close", () => {
              console.log("[ElevenLabs] Disconnected");
            });
          } catch (error) {
            console.error("[ElevenLabs] Setup error:", error);
          }
        }

        setupElevenLabs();

        ws.on("message", (message) => {
          try {
            const msg = JSON.parse(message);
            switch (msg.event) {
              case "start":
                streamSid = msg.streamSid;
                callSid = msg.callSid;
                customParameters = msg.customParameters;
                console.log(
                  `[Twilio] Поток запущен - StreamSid: ${streamSid}, CallSid: ${callSid}`,
                );
                break;
              case "media":
                streamSid = msg.streamSid;
                if (
                  elevenLabsWs &&
                  elevenLabsWs.readyState === WebSocket.OPEN
                ) {
                  const audioMessage = {
                    user_audio_chunk: Buffer.from(
                      msg.media.payload,
                      "base64",
                    ).toString("base64"),
                  };
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                }
                break;
              case "stop":
                console.log(`[Twilio] Stream ${streamSid} ended`);
                if (
                  elevenLabsWs &&
                  elevenLabsWs.readyState === WebSocket.OPEN
                ) {
                  elevenLabsWs.close();
                }
                break;
              default:
                console.log(`[Twilio] Unhandled event: ${msg.event}`);
            }
          } catch (error) {
            console.error("[Twilio] Error processing message:", error);
          }
        });

        ws.on("close", () => {
          console.log("[Twilio] Client disconnected");
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
        });
      },
    );
  });
}
