# CLAUDE.md — context for agents working on Agent Fleet

This file is auto-loaded by Claude Code. If you're an agent working in this repo,
read it fully — it captures the project, its decisions, and what's still open.

## What this project is
Agent Fleet is a **personal agent management system**: an Electron desktop app
where each **tab is a terminal running a Claude Code agent**. Tabs are grouped
under **projects**, and each tab is a persistent **agent/role** (e.g. "Software
Engineer", "Project Manager") that works in the project folder. It's built by one
user (GitHub: `Incendio03`) for their own use, and is now self-hosted (the app is
used to develop itself).

## Tech stack
- **Shell:** Electron (main process = backend, renderer = UI).
- **UI:** React + TypeScript + xterm.js (terminal display). Build tool: electron-vite.
- **Backend (main process):** node-pty (runs `claude` in a PTY per tab), git
  worktrees (optional isolation), local JSON persistence.
- **Cloud (optional):** Supabase (Postgres + Auth + RLS) for login + cross-device
  sync of projects/tabs. GitHub OAuth via a loopback redirect.
- **State:** zustand (renderer).

## Architecture map
```
src/
  main/                 Electron main process (the backend)
    index.ts            app bootstrap, window, loopback auth server wiring
    ipc.ts              ALL ipc handlers (UI <-> backend bridge)
    sessionManager.ts   spawns/streams `claude` in node-pty per tab
    claude.ts           resolves claude path; detects supported flags from --help;
                        builds the launch command (fresh vs --resume)
    worktree.ts         git worktree create/remove (only used when isolate=true)
    team.ts             named agents (--name), team prompt, .fleet/board.md, messages
                        read from Claude transcripts (~/.claude/projects/<cwd>/<sid>.jsonl)
    authServer.ts       loopback HTTP server on 127.0.0.1:8923 for OAuth redirect
    store.ts            local JSON persistence (userData/data/store.json)
  preload/index.ts      the secure window.fleet bridge (only API the UI can call)
  renderer/src/
    App.tsx             layout; mounts terminals; resume overlay
    components/         ProjectSidebar, TabBar, TerminalView, dialogs, AuthBar
    lib/supabase.ts     optional Supabase client + GitHub PKCE login
    lib/cloudSync.ts    push/pull projects+tabs <-> Supabase (maps camel<->snake)
    lib/terminalRegistry.ts  routes PTY output to the right xterm, buffers early bytes
    store/useStore.ts   zustand store + actions
  shared/types.ts       types + IPC channel names shared by both sides
supabase/migrations/    SQL schema + RLS (0001_init, 0002_session_id)
```

## Key design decisions (don't undo without reason)
- **Local-first.** The app always reads/writes `store.json` locally and works fully
  offline. Supabase is optional; when configured it mirrors data for cross-device sync.
- **A tab = an agent/role, not a task.** The new-agent dialog asks for a name/role +
  optional instructions. Agents run **directly in the project folder** by default.
- **Worktrees are opt-in** (`CreateTabOptions.isolate`, default false). The UI does
  not currently expose a toggle — the agent creates branches conversationally when
  asked. The backend still supports isolate=true (creates a worktree + branch).
- **A project can be ANY folder** — a single git repo OR a container of several repos.
  Worktree isolation only applies to git repos.
- **CLI flags are capability-detected** from `claude --help` (see claude.ts), so the
  app adapts to the installed Claude Code version instead of hard-coding flags.
- **Session resume** uses a stable per-tab session id (`--session-id` on first launch,
  `--resume <id>` to reattach, `--continue` fallback). This restores the agent's full
  conversation memory, not just files.
- **OAuth uses a loopback redirect** (`http://localhost:8923/callback`), NOT a custom
  URL scheme — custom schemes failed on Windows. Don't reintroduce `agentfleet://`.

## Conventions
- **Versioning:** SemVer. Pre-1.0: minor = feature, patch = fix. Bump with
  `npm version minor|patch` (updates package.json, commits, tags). Then
  `git push --follow-tags`. Update CHANGELOG.md's [Unreleased] as you go.
- **In-app version:** injected at build time as `__APP_VERSION__` (see
  electron.vite.config.ts), shown in the sidebar header.
- **Commits:** conventional-ish (`feat:`, `fix:`, `chore:`, `docs:`). Co-author line:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Typecheck before committing:** `npm run typecheck`. Build check: `npm run build`.

## How to run
```powershell
npm install
npm run dev     # launches the Electron app with HMR
```
`claude` CLI must be installed and logged in once (all tabs share that login).
Env lives in `.env` (git-ignored); see `.env.example`. Required for cloud:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the Supabase *publishable* key).

## External setup already done
- **GitHub repo:** https://github.com/Incendio03/agent-fleet (public).
- **Supabase:** project `tcasnhvwfiaydtnizgdf`. Migrations 0001 + 0002 have been run.
  GitHub auth provider is configured; redirect allow-list includes
  `http://localhost:8923/callback`. `.env` has the URL + publishable key locally.
- **Windows machine**, `claude` 2.1.327 (supports --model/--effort/--permission-mode/
  --session-id/--resume/--continue). node-pty ships prebuilt binaries (no build tools).

## Current status (as of v0.2.2, 2026-11-18)
Working: app builds/runs, projects persist, agent/role tabs, Supabase login (tested,
works), cloud sync wiring, session-resume feature (built, flags verified present).
Recently fixed: blank terminal after restart (0.2.1, liveTabIds); "Project not found"
on tab create for cloud-synced projects (0.2.2, cloud restore now persists to the
local store via store:import).

## Open threads / next steps (START HERE)
1. **Verify tab persistence end to end.** Launch an agent tab, close/reopen the app,
   confirm it comes back (now that restored tabs show the Resume overlay and are
   persisted locally). Needs a real run-through.
2. **Test session-resume end to end.** Launch an agent, give it a memorable fact,
   `/exit` it (or quit app), click "Resume agent", confirm it recalls the fact.
3. **Deployment (deferred until stable).** Package with electron-builder; add
   electron-updater + GitHub Releases for auto-update (install once, self-updates).
   SemVer/CHANGELOG/tags are already in place to support this.
5. **Nice-to-haves:** save terminal transcripts; per-tab "open PR" button; auto-clone a
   project's repo on a new device during restore.
```
