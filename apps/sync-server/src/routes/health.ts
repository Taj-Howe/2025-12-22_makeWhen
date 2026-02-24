import type { FastifyInstance } from "fastify";
import { pingDatabase } from "../db/client.ts";

export const registerHealthRoutes = async (app: FastifyInstance) => {
  app.get("/health/live", async () => {
    return {
      ok: true,
      status: "live",
      service: "sync-server",
      now: Date.now(),
    };
  });

  app.get("/health/ready", async (_request, reply) => {
    const ping = await pingDatabase();
    if (!ping.ok) {
      reply.code(503);
      return {
        ok: false,
        status: "not_ready",
        service: "sync-server",
        error: ping.error,
      };
    }
    return {
      ok: true,
      status: "ready",
      service: "sync-server",
      now: Date.now(),
    };
  });
};
