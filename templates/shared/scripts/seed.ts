#!/usr/bin/env bun

import { SQL } from "bun";

const databaseUrl = Bun.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const stage = normalizeStage(Bun.env.SERVICE_STAGE || Bun.env.APP_ENV || Bun.env.NODE_ENV || "local");
if (stage === "prod" && Bun.env.SEED_PROD !== "true") {
  console.log("Skipping production seed data. Set SEED_PROD=true to apply production seeds.");
  process.exit(0);
}

const sql = new SQL(databaseUrl);

try {
  const entries = seedEntries(stage);
  for (const entry of entries) {
    await sql`
      insert into waitlist_entries (id, email, name, company, source, status)
      values (${entry.id}, ${entry.email}, ${entry.name}, ${entry.company}, ${entry.source}, ${entry.status})
      on conflict (email) do update set
        name = excluded.name,
        company = excluded.company,
        source = excluded.source,
        updated_at = now()
    `;

    await sql`
      insert into waitlist_triggers (id, type, entry_id, status, payload_json)
      values (${`${entry.id}-trigger`}, ${"seed"}, ${entry.id}, ${"queued"}, ${JSON.stringify({ stage, email: entry.email })})
      on conflict (id) do nothing
    `;
  }

  console.log(`Seeded ${entries.length} waitlist entr${entries.length === 1 ? "y" : "ies"} for ${stage}.`);
} finally {
  await sql.close();
}

function normalizeStage(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === "production" || normalized === "main") {
    return "prod";
  }
  if (normalized === "development") {
    return "local";
  }
  return normalized || "local";
}

function seedEntries(stage: string) {
  return [
    {
      id: `seed-${stage}-founder`,
      email: `founder+${stage}@example.com`,
      name: "Founder Example",
      company: "Example Co",
      source: `seed:${stage}`,
      status: "joined",
    },
    {
      id: `seed-${stage}-operator`,
      email: `operator+${stage}@example.com`,
      name: "Operator Example",
      company: "Example Co",
      source: `seed:${stage}`,
      status: "joined",
    },
  ];
}
