import http from "node:http";
import { loadConfig } from "./config.ts";
import { buildHandler } from "./app.ts";
import { runMigrations } from "./db/migrations.ts";

const start = async () => {
  const config = loadConfig();
  const handler = buildHandler(config.corsOrigin);

  if (config.databaseUrl) {
    await runMigrations();
  } else {
    console.warn("DATABASE_URL is not configured; /health/ready will return 503.");
  }

  const server = http.createServer((request, response) => {
    void handler(request, response).catch((error) => {
      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => resolve());
  });

  console.log(
    JSON.stringify({
      service: "sync-server",
      address: `http://127.0.0.1:${config.port}`,
      authMode: config.authMode,
      corsOrigin: config.corsOrigin,
      hasDatabaseUrl: Boolean(config.databaseUrl),
    })
  );

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}. Shutting down.`);
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

start().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
