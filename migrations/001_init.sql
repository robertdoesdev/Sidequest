-- SideQuest schema v1. Plain PostgreSQL (works on Supabase, Neon, RDS, local).
-- Applied by `npm run migrate` (lib/db.mjs). Safe to re-run: applied versions are skipped.

create table users (
  id             integer generated always as identity primary key,
  username       text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name   text not null check (char_length(display_name) between 1 and 30),
  pass_salt      text not null,
  pass_hash      text not null,
  -- public-profile fields (the ONLY user columns the public API ever returns)
  bio            text not null default '' check (char_length(bio) <= 160),
  avatar         text not null default '' check (avatar in ('', 'sun', 'bolt', 'leaf', 'wave', 'star', 'moon')),
  profile_public boolean not null default true,
  created_at     timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,                       -- sha256 of the bearer token; the token itself is never stored
  user_id    integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions(user_id);
create index sessions_expiry_idx on sessions(expires_at);

-- Private synced progress. Never joined into any public query.
create table user_state (
  user_id    integer primary key references users(id) on delete cascade,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

create table friendships (
  user_a     integer not null references users(id) on delete cascade,
  user_b     integer not null references users(id) on delete cascade,
  requester  integer not null references users(id) on delete cascade,
  status     text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b),                           -- one canonical row per pair
  check (requester = user_a or requester = user_b)
);
create index friendships_b_idx on friendships(user_b);

create table blocks (
  blocker    integer not null references users(id) on delete cascade,
  blocked    integer not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
create index blocks_blocked_idx on blocks(blocked);

create table challenges (
  id           text primary key check (id ~ '^[a-f0-9]{16}$'),
  from_user    integer not null references users(id) on delete cascade,
  to_user      integer not null references users(id) on delete cascade,
  quest_id     text not null,
  message      text not null default '' check (char_length(message) <= 140),
  status       text not null check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'completed')),
  from_done_at timestamptz,
  to_done_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  check (from_user <> to_user)
);
create index challenges_from_idx on challenges(from_user, updated_at desc);
create index challenges_to_idx on challenges(to_user, updated_at desc);
-- A sender cannot have two open challenges for the same quest with the same friend (also stops double-submit races).
create unique index challenges_open_unique on challenges(from_user, to_user, quest_id) where status in ('pending', 'accepted');

-- Community Showcase. A row exists ONLY if the user explicitly published it.
create table showcase_posts (
  id           integer generated always as identity primary key,
  user_id      integer not null references users(id) on delete cascade,
  quest_id     text not null,
  completed_at timestamptz not null,
  reflection   text not null default '' check (char_length(reflection) <= 40),
  note         text not null default '' check (char_length(note) <= 140),
  created_at   timestamptz not null default now(),
  unique (user_id, quest_id)                          -- retries / double taps cannot create duplicates
);
create index showcase_feed_idx on showcase_posts(created_at desc, id desc);

create table reports (
  id          integer generated always as identity primary key,
  reporter    integer not null references users(id) on delete cascade,
  target_user integer not null references users(id) on delete cascade,
  showcase_id integer,
  reason      text not null default '' check (char_length(reason) <= 300),
  created_at  timestamptz not null default now(),
  check (reporter <> target_user)
);
create index reports_target_idx on reports(target_user);

create table push_subscriptions (
  endpoint   text primary key,
  user_id    integer not null references users(id) on delete cascade,
  sub        jsonb not null,
  created_at timestamptz not null default now()
);
create index push_subs_user_idx on push_subscriptions(user_id);

create table push_settings (
  user_id    integer primary key references users(id) on delete cascade,
  prefs      jsonb not null,
  tz_offset  integer not null default 0,
  sent       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Shared rate-limit counters (works across serverless instances, unlike in-memory maps).
create table rate_limits (
  key          text primary key,
  window_start timestamptz not null,
  hits         integer not null
);

-- Defence in depth: all access goes through the server using the table-owner role (which bypasses RLS).
-- With RLS on and NO policies, Supabase's public REST/anon key cannot read or write any of these tables.
alter table users              enable row level security;
alter table sessions           enable row level security;
alter table user_state         enable row level security;
alter table friendships        enable row level security;
alter table blocks             enable row level security;
alter table challenges         enable row level security;
alter table showcase_posts     enable row level security;
alter table reports            enable row level security;
alter table push_subscriptions enable row level security;
alter table push_settings      enable row level security;
alter table rate_limits        enable row level security;
