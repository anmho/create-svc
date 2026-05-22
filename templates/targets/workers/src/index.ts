import { Hono } from "hono";
import { authMiddleware } from "./auth";
import { createStorage } from "./storage";

type Env = {
  HYPERDRIVE?: Hyperdrive;
  AUTH_ENABLED?: string;
  AUTH_ISSUER?: string;
  AUTH_AUDIENCE?: string;
  AUTH_JWKS_URL?: string;
};

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/healthz", (context) => context.json({ status: "ok" }));
  app.get("/readyz", (context) => context.json({ status: "ok" }));
  app.get("/", (context) =>
    context.json({
      service: "{{SERVICE_NAME}}",
      domain: "waitlist",
      apiOrigin: "https://api.{{SERVICE_NAME}}.anmho.com",
    })
  );

  app.use("/v1/*", authMiddleware());

  app.post("/v1/waitlist", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return context.json({ error: "valid email is required", code: "invalid_email" }, 400);
    }

    const result = await createStorage(context.env).joinWaitlist({
      email,
      name: body.name ? String(body.name) : null,
      company: body.company ? String(body.company) : null,
      source: body.source ? String(body.source) : null,
    });
    return context.json(result, result.created ? 201 : 200);
  });

  app.get("/v1/waitlist", async (context) => {
    const email = String(context.req.query("email") ?? "").trim().toLowerCase();
    if (!email) {
      return context.json({ error: "email is required", code: "missing_email" }, 400);
    }
    return context.json({ entry: await createStorage(context.env).getWaitlistEntryByEmail(email) });
  });

  app.get("/v1/waitlist/:entryId", async (context) => {
    const entry = await createStorage(context.env).getWaitlistEntry(context.req.param("entryId"));
    if (!entry) {
      return context.json({ error: "waitlist entry not found", code: "not_found" }, 404);
    }
    return context.json({ entry });
  });

  app.get("/v1/admin/waitlist", async (context) => {
    try {
      const status = context.req.query("status");
      return context.json({
        entries: await createStorage(context.env).listWaitlistEntries({
          status: status ? normalizeStatus(status) : null,
          limit: parseOptionalNumber(context.req.query("limit")),
        }),
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.get("/v1/admin/waitlist/export", async (context) => {
    try {
      const status = context.req.query("status");
      const entries = await createStorage(context.env).listWaitlistEntries({
        status: status ? normalizeStatus(status) : null,
        limit: parseOptionalNumber(context.req.query("limit")),
      });
      return new Response(entriesToCsv(entries), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="waitlist.csv"',
        },
      });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.patch("/v1/admin/waitlist/:entryId", async (context) => {
    try {
      const body = await context.req.json().catch(() => ({}));
      const status = normalizeStatus(String(body.status ?? ""));
      const entry = await createStorage(context.env).updateWaitlistEntryStatus(context.req.param("entryId"), status);
      if (!entry) {
        return context.json({ error: "waitlist entry not found", code: "not_found" }, 404);
      }
      return context.json({ entry });
    } catch (error) {
      return writeError(context, error);
    }
  });

  app.post("/v1/triggers/waitlist", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    const trigger = await createStorage(context.env).recordTrigger({
      type: String(body.type ?? "manual"),
      entryId: body.entry_id ?? body.entryId ?? null,
      payload: body,
    });
    return context.json({ trigger }, 202);
  });

  app.post("/webhooks/:provider", async (context) => {
    const rawBody = await context.req.text();
    const trigger = await createStorage(context.env).recordTrigger({
      type: `webhook.${context.req.param("provider")}`,
      entryId: null,
      payload: {
        headers: Object.fromEntries(context.req.raw.headers),
        rawBody,
      },
    });
    return context.json({ trigger }, 202);
  });

  app.get("/webhooks/:provider/health", (context) => context.json({ status: "ok", provider: context.req.param("provider") }));
  return app;
}

const app = createApp();

class ValidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function normalizeStatus(value: string) {
  const status = value.trim().toLowerCase();
  if (status === "joined" || status === "invited" || status === "converted" || status === "archived") {
    return status;
  }
  throw new ValidationError("invalid_status", "status must be one of joined, invited, converted, archived");
}

function writeError(context: any, error: unknown) {
  if (error instanceof ValidationError) {
    return context.json({ error: error.message, code: error.code }, 400);
  }
  console.error(error);
  return context.json({ error: "internal server error", code: "internal" }, 500);
}

function parseOptionalNumber(value: string | undefined) {
  return value ? Number(value) : null;
}

function entriesToCsv(entries: Awaited<ReturnType<ReturnType<typeof createStorage>["listWaitlistEntries"]>>) {
  const headers = ["id", "email", "name", "company", "source", "status", "created_at", "updated_at"];
  return [
    headers.join(","),
    ...entries.map((entry) =>
      [
        entry.id,
        entry.email,
        entry.name ?? "",
        entry.company ?? "",
        entry.source ?? "",
        entry.status,
        entry.created_at,
        entry.updated_at,
      ]
        .map(csvCell)
        .join(",")
    ),
  ].join("\n");
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, context: ExecutionContext) {
    context.waitUntil(
      createStorage(env).claimQueuedTriggers(10).then((triggers) => {
        console.log("processed waitlist triggers", triggers.length);
      })
    );
  },
};
