import WebSocket from "ws";
import fetch from "node-fetch";

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.error("Missing required environment variables");
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  // Функция для получения подписанного URL для подключения к ElevenLabs
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

  // TwiML-роут для входящего вызова от Twilio
  fastify.all("/incoming-call-eleven", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;
    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket-роут для обработки медиа-потока от Twilio
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get(
      "/media-stream",
      { websocket: true },
      async (connection, req) => {
        console.info("[Server] Twilio connected to media stream.");

        let streamSid = null;
        let elevenLabsWs = null;

        try {
          // Получаем подписанный URL и подключаемся к ElevenLabs
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[II] Connected to Conversational AI.");
          });

          // Обработка сообщений от ElevenLabs – пересылаем их в Twilio
          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);
              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.info(
                    "[II] Received conversation initiation metadata.",
                  );
                  break;
                case "audio":
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: { payload: message.audio.chunk },
                    };
                    connection.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: { payload: message.audio_event.audio_base_64 },
                    };
                    connection.send(JSON.stringify(audioData));
                  }
                  break;
                case "interruption":
                  connection.send(
                    JSON.stringify({ event: "clear", streamSid }),
                  );
                  break;
                case "ping":
                  if (message.ping_event?.event_id) {
                    const pongResponse = {
                      type: "pong",
                      event_id: message.ping_event.event_id,
                    };
                    elevenLabsWs.send(JSON.stringify(pongResponse));
                  }
                  break;
                default:
                  console.log(`[II] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[II] Error parsing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[II] WebSocket error:", error);
          });
          elevenLabsWs.on("close", () => {
            console.log("[II] Disconnected from ElevenLabs.");
          });

          // Обработка сообщений от Twilio
          connection.on("message", async (message) => {
            try {
              const data = JSON.parse(message);
              switch (data.event) {
                case "start":
                  // Используем предложенный вариант – получаем streamSid прямо из data
                  streamSid = data.streamSid;
                  console.log(streamSid);
                  console.log(
                    `[Twilio] Поток запущен с идентификатором: ${streamSid}`,
                  );
                  break;
                case "media":
                  // Обновляем streamSid из data и пересылаем аудио
                  streamSid = data.streamSid;
                  if (
                    elevenLabsWs &&
                    elevenLabsWs.readyState === WebSocket.OPEN
                  ) {
                    const audioMessage = {
                      user_audio_chunk: Buffer.from(
                        data.media.payload,
                        "base64",
                      ).toString("base64"),
                    };
                    elevenLabsWs.send(JSON.stringify(audioMessage));
                  }
                  break;
                case "stop":
                  if (elevenLabsWs) {
                    elevenLabsWs.close();
                  }
                  break;
                default:
                  console.log(
                    `[Twilio] Received unhandled event: ${data.event}`,
                  );
              }
            } catch (error) {
              console.error("[Twilio] Error processing message:", error);
            }
          });

          connection.on("close", () => {
            if (elevenLabsWs) {
              elevenLabsWs.close();
            }
            console.log("[Twilio] Client disconnected");
          });

          connection.on("error", (error) => {
            console.error("[Twilio] WebSocket error:", error);
            if (elevenLabsWs) {
              elevenLabsWs.close();
            }
          });
        } catch (error) {
          console.error("[Server] Error initializing conversation:", error);
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          connection.socket.close();
        }
      },
    );
  });
}
