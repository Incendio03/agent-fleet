-- =============================================================================
-- Agent Fleet — add per-tab agent kind ('claude' | 'codex' | ...)
--
-- Run this in Supabase SQL Editor (after 0002_session_id.sql). Safe to re-run.
--
-- Without it, a Codex tab restored on another device comes back as Claude.
-- Existing rows predate other agents, so they are Claude.
-- =============================================================================

alter table public.tabs
  add column if not exists agent text not null default 'claude';

-- No RLS changes needed: the existing "own rows only" policies on public.tabs
-- already cover the new column.
