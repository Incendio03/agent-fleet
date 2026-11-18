-- =============================================================================
-- Agent Fleet — initial schema + Row Level Security
--
-- Run this in your Supabase project:
--   Dashboard -> SQL Editor -> paste -> Run
--   (or: npx supabase db push, if you use the CLI)
--
-- Security model: every table has RLS ENABLED, and every row carries a
-- `user_id`. The policies below allow a logged-in user to touch ONLY their own
-- rows (auth.uid() = user_id). This is what makes it safe to ship the public
-- "anon" key inside the desktop app — the key can never read another user's data.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- projects: a pointer to a git repo on the user's machine.
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null,
  local_path  text not null,
  github_url  text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tabs: one agent session working on one task within a project.
-- ---------------------------------------------------------------------------
create table if not exists public.tabs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  title           text not null,
  task            text not null default '',
  model           text not null default 'sonnet',
  effort          text not null default 'high',
  permission_mode text not null default 'acceptEdits',
  branch          text not null,
  worktree_path   text not null,
  status          text not null default 'idle',
  exit_code       integer,
  created_at      timestamptz not null default now()
);

create index if not exists tabs_project_id_idx on public.tabs (project_id);

-- ---------------------------------------------------------------------------
-- logs: optional transcript/output snapshots per tab (bulky output can also
-- go to Supabase Storage; this table is for short notes / final transcripts).
-- ---------------------------------------------------------------------------
create table if not exists public.logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tab_id     uuid not null references public.tabs (id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default now()
);

create index if not exists logs_tab_id_idx on public.logs (tab_id);

-- ===========================================================================
-- Row Level Security
-- Step 1: enable RLS (this alone = deny everything).
-- Step 2: add "own rows only" policies (below) or the tables stay locked.
-- ===========================================================================
alter table public.projects enable row level security;
alter table public.tabs     enable row level security;
alter table public.logs     enable row level security;

-- projects --------------------------------------------------------------
create policy "projects: read own"   on public.projects for select using  (auth.uid() = user_id);
create policy "projects: insert own" on public.projects for insert with check (auth.uid() = user_id);
create policy "projects: update own" on public.projects for update using  (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "projects: delete own" on public.projects for delete using  (auth.uid() = user_id);

-- tabs ------------------------------------------------------------------
create policy "tabs: read own"   on public.tabs for select using  (auth.uid() = user_id);
create policy "tabs: insert own" on public.tabs for insert with check (auth.uid() = user_id);
create policy "tabs: update own" on public.tabs for update using  (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "tabs: delete own" on public.tabs for delete using  (auth.uid() = user_id);

-- logs ------------------------------------------------------------------
create policy "logs: read own"   on public.logs for select using  (auth.uid() = user_id);
create policy "logs: insert own" on public.logs for insert with check (auth.uid() = user_id);
create policy "logs: update own" on public.logs for update using  (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "logs: delete own" on public.logs for delete using  (auth.uid() = user_id);
