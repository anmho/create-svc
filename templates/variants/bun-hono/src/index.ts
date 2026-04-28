import { Hono } from "hono";

type ConnectRequest = {
  name?: string;
};

export function createApp() {
  const app = new Hono();

  app.get("/healthz", (context) => context.json({ status: "ok", runtime: "bun", framework: "hono" }));
  app.get("/", (context) => {
    const databaseConfigured = Boolean(Bun.env.DATABASE_URL?.trim());
    return context.json({
      service: "{{SERVICE_NAME}}",
      databaseConfigured,
      apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
    });
  });
  app.post("/rpc.example.v1.Service/Ping", async (context) => {
    const payload = (await context.req.json().catch(() => ({}))) as ConnectRequest;
    return context.json(
      {
        message: `hello ${payload.name?.trim() || "{{SERVICE_NAME}}"}`,
      },
      200,
      {
        "Content-Type": "application/json",
      }
    );
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
