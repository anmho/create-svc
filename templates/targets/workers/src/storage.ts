import { Client } from "pg";

export type WaitlistEntry = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  source: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type WaitlistTrigger = {
  id: string;
  type: string;
  entry_id: string | null;
  status: string;
  payload_json: string;
  created_at: string;
  processed_at: string | null;
};

export type WaitlistStorage = {
  joinWaitlist(input: {
    email: string;
    name: string | null;
    company: string | null;
    source: string | null;
  }): Promise<{ entry: WaitlistEntry; created: boolean }>;
  getWaitlistEntryByEmail(email: string): Promise<WaitlistEntry | null>;
  getWaitlistEntry(entryId: string): Promise<WaitlistEntry | null>;
  listWaitlistEntries(input?: { status?: string | null; limit?: number | null }): Promise<WaitlistEntry[]>;
  updateWaitlistEntryStatus(entryId: string, status: string): Promise<WaitlistEntry | null>;
  recordTrigger(input: {
    type: string;
    entryId: string | null;
    payload: unknown;
  }): Promise<WaitlistTrigger>;
  claimQueuedTriggers(limit: number): Promise<WaitlistTrigger[]>;
};

type Env = {
  HYPERDRIVE?: Hyperdrive;
};

const memoryStorage = createMemoryStorage();

export function createStorage(env: Env = {}): WaitlistStorage {
  if (env.HYPERDRIVE?.connectionString) {
    return createPostgresStorage(env.HYPERDRIVE.connectionString);
  }
  return memoryStorage;
}

function createPostgresStorage(connectionString: string): WaitlistStorage {
  return {
    async joinWaitlist(input) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const now = new Date().toISOString();
        const result = await client.query<WaitlistEntry>(
          `
insert into waitlist_entries (id, email, name, company, source, status, created_at, updated_at)
values ($1, $2, $3, $4, $5, 'joined', $6, $6)
on conflict (email) do update
set
  name = coalesce(excluded.name, waitlist_entries.name),
  company = coalesce(excluded.company, waitlist_entries.company),
  source = coalesce(excluded.source, waitlist_entries.source),
  updated_at = excluded.updated_at
returning id, email, name, company, source, status, created_at, updated_at, (xmax = 0) as created
`,
          [crypto.randomUUID(), input.email, input.name, input.company, input.source, now]
        );
        const row = result.rows[0] as WaitlistEntry & { created?: boolean };
        return { entry: normalizeEntry(row), created: Boolean(row.created) };
      } finally {
        await client.end();
      }
    },

    async getWaitlistEntryByEmail(email) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const result = await client.query<WaitlistEntry>(
          "select id, email, name, company, source, status, created_at, updated_at from waitlist_entries where email = $1",
          [email]
        );
        return result.rows[0] ? normalizeEntry(result.rows[0]) : null;
      } finally {
        await client.end();
      }
    },

    async getWaitlistEntry(entryId) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const result = await client.query<WaitlistEntry>(
          "select id, email, name, company, source, status, created_at, updated_at from waitlist_entries where id = $1",
          [entryId]
        );
        return result.rows[0] ? normalizeEntry(result.rows[0]) : null;
      } finally {
        await client.end();
      }
    },

    async listWaitlistEntries(input = {}) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const limit = clampLimit(input.limit);
        const result = input.status
          ? await client.query<WaitlistEntry>(
              `
select id, email, name, company, source, status, created_at, updated_at
from waitlist_entries
where status = $1
order by created_at desc
limit $2
`,
              [input.status, limit]
            )
          : await client.query<WaitlistEntry>(
              `
select id, email, name, company, source, status, created_at, updated_at
from waitlist_entries
order by created_at desc
limit $1
`,
              [limit]
            );
        return result.rows.map(normalizeEntry);
      } finally {
        await client.end();
      }
    },

    async updateWaitlistEntryStatus(entryId, status) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const result = await client.query<WaitlistEntry>(
          `
update waitlist_entries
set status = $2, updated_at = now()
where id = $1
returning id, email, name, company, source, status, created_at, updated_at
`,
          [entryId, status]
        );
        return result.rows[0] ? normalizeEntry(result.rows[0]) : null;
      } finally {
        await client.end();
      }
    },

    async recordTrigger(input) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const now = new Date().toISOString();
        const result = await client.query<WaitlistTrigger>(
          `
insert into waitlist_triggers (id, type, entry_id, status, payload_json, created_at)
values ($1, $2, $3, 'queued', $4, $5)
returning id, type, entry_id, status, payload_json, created_at, processed_at
`,
          [crypto.randomUUID(), input.type, input.entryId, JSON.stringify(input.payload ?? {}), now]
        );
        return normalizeTrigger(result.rows[0]);
      } finally {
        await client.end();
      }
    },

    async claimQueuedTriggers(limit) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        await ensureSchema(client);
        const result = await client.query<WaitlistTrigger>(
          `
update waitlist_triggers
set status = 'processed', processed_at = now()
where id in (
  select id
  from waitlist_triggers
  where status = 'queued'
  order by created_at asc
  limit $1
  for update skip locked
)
returning id, type, entry_id, status, payload_json, created_at, processed_at
`,
          [limit]
        );
        return result.rows.map(normalizeTrigger);
      } finally {
        await client.end();
      }
    },
  };
}

async function ensureSchema(client: Client) {
  await client.query(`
create table if not exists waitlist_entries (
  id text primary key,
  email text not null unique,
  name text,
  company text,
  source text,
  status text not null default 'joined',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists waitlist_triggers (
  id text primary key,
  type text not null,
  entry_id text references waitlist_entries(id) on delete set null,
  status text not null default 'queued',
  payload_json text not null default '{}',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists waitlist_triggers_status_created_idx
  on waitlist_triggers (status, created_at);
`);
}

function createMemoryStorage(): WaitlistStorage {
  const entries = new Map<string, WaitlistEntry>();
  const entriesByEmail = new Map<string, string>();
  const triggers = new Map<string, WaitlistTrigger>();

  return {
    async joinWaitlist(input) {
      const existingId = entriesByEmail.get(input.email);
      if (existingId) {
        const existing = entries.get(existingId)!;
        const updated = {
          ...existing,
          name: input.name ?? existing.name,
          company: input.company ?? existing.company,
          source: input.source ?? existing.source,
          updated_at: new Date().toISOString(),
        };
        entries.set(existing.id, updated);
        return { entry: updated, created: false };
      }

      const now = new Date().toISOString();
      const entry = {
        id: crypto.randomUUID(),
        email: input.email,
        name: input.name,
        company: input.company,
        source: input.source,
        status: "joined",
        created_at: now,
        updated_at: now,
      };
      entries.set(entry.id, entry);
      entriesByEmail.set(entry.email, entry.id);
      return { entry, created: true };
    },

    async getWaitlistEntryByEmail(email) {
      const id = entriesByEmail.get(email);
      return id ? entries.get(id) ?? null : null;
    },

    async getWaitlistEntry(entryId) {
      return entries.get(entryId) ?? null;
    },

    async listWaitlistEntries(input = {}) {
      return [...entries.values()]
        .filter((entry) => !input.status || entry.status === input.status)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, clampLimit(input.limit));
    },

    async updateWaitlistEntryStatus(entryId, status) {
      const entry = entries.get(entryId);
      if (!entry) {
        return null;
      }
      const updated = {
        ...entry,
        status,
        updated_at: new Date().toISOString(),
      };
      entries.set(entry.id, updated);
      return updated;
    },

    async recordTrigger(input) {
      const now = new Date().toISOString();
      const trigger = {
        id: crypto.randomUUID(),
        type: input.type,
        entry_id: input.entryId,
        status: "queued",
        payload_json: JSON.stringify(input.payload ?? {}),
        created_at: now,
        processed_at: null,
      };
      triggers.set(trigger.id, trigger);
      return trigger;
    },

    async claimQueuedTriggers(limit) {
      const claimed = [...triggers.values()]
        .filter((trigger) => trigger.status === "queued")
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .slice(0, limit)
        .map((trigger) => ({
          ...trigger,
          status: "processed",
          processed_at: new Date().toISOString(),
        }));

      for (const trigger of claimed) {
        triggers.set(trigger.id, trigger);
      }
      return claimed;
    },
  };
}

function normalizeEntry(row: WaitlistEntry): WaitlistEntry {
  return {
    ...row,
    created_at: normalizeDate(row.created_at),
    updated_at: normalizeDate(row.updated_at),
  };
}

function normalizeTrigger(row: WaitlistTrigger): WaitlistTrigger {
  return {
    ...row,
    created_at: normalizeDate(row.created_at),
    processed_at: row.processed_at ? normalizeDate(row.processed_at) : null,
  };
}

function clampLimit(value: number | null | undefined) {
  if (!value || !Number.isFinite(value)) {
    return 100;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 500);
}

function normalizeDate(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
