import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { registerInboundRoutes } from "./inbound-calls.js";
import { registerOutboundRoutes } from "./outbound-calls.js";

// Загружаем переменные окружения
dotenv.config();

const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

const start = async () => {
  try {
    await registerInboundRoutes(fastify);
    await registerOutboundRoutes(fastify);
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`[Server] Listening on port ${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  process.exit(1);
});

start();
