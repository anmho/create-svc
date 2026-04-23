import { Hono } from "hono";

export function createApp() {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok", runtime: "bun", framework: "hono" }));
  app.get("/", (context) => {
    const databaseConfigured = Boolean(Bun.env.DATABASE_URL?.trim());
    return context.json({
      service: "{{SERVICE_NAME}}",
      databaseConfigured,
    });
  });

  return app;
}

if (import.meta.main) {
  const app = createApp();
  Bun.serve({
    port: Number(Bun.env.PORT ?? 8080),
    fetch: app.fetch,
  });
}
