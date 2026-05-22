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
  entry_id text references waitlist_entries(id),
  status text not null default 'queued',
  payload_json text not null,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
