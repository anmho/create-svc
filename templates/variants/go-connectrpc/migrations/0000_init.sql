create table if not exists users (
  id text primary key,
  username text not null unique,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conversations (
  id text primary key,
  title text,
  created_by_user_id text not null references users(id),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists conversation_participants (
  conversation_id text not null references conversations(id),
  user_id text not null references users(id),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists messages (
  id text primary key,
  conversation_id text not null references conversations(id),
  user_id text not null references users(id),
  body text not null,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists attachments (
  id text primary key,
  conversation_id text not null references conversations(id),
  message_id text references messages(id),
  uploaded_by_user_id text not null references users(id),
  storage_bucket text not null,
  storage_key text not null,
  content_type text not null,
  byte_size bigint not null,
  filename text not null,
  status text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  external_event_id text not null,
  event_type text not null,
  signature_valid text not null,
  status text not null,
  payload_json text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, external_event_id)
);
