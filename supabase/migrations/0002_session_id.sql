-- =============================================================================
-- Agent Fleet — add per-tab Claude session id (for session resume)
--
-- Run this in Supabase SQL Editor (after 0001_init.sql). Safe to re-run.
--
-- Stores the stable Claude Code session id for each tab, so a tab can later be
-- resumed with `claude --resume <session_id>`, restoring the agent's full
-- conversation memory. Existing rows get a generated id as a backfill.
-- =============================================================================

alter table public.tabs
  add column if not exists session_id uuid not null default gen_random_uuid();

-- No RLS changes needed: the existing "own rows only" policies on public.tabs
-- already cover the new column.
