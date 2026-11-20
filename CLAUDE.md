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
    store.ts            local JSON persistence: data/store.json (signed out) or
                        data/users/<userId>.json (per account; renderer picks via store:setUser)
    chat.ts             general chats: drives the agent CLIs WITHOUT a terminal
                        (claude -p stream-json, kept per chat; codex exec --json per message)
    chatStore.ts        chat list + messages + images on disk (data/chats, or
                        data/users/<userId>/chats); no Electron imports
    skills.ts           skills per agent: list / turn off (skills-disabled/) / remove /
                        install via a review stage; per-chat plugin of chosen skills
  preload/index.ts      the secure window.fleet bridge (only API the UI can call)
  renderer/src/
    App.tsx             layout; mounts terminals; resume overlay; chat view vs project view
    components/         ProjectSidebar, TabBar, TerminalView, dialogs, AuthBar,
                        ChatList / ChatView / ChatInput / Markdown (general chats),
                        SkillsSettings + ChatSkillsPicker (skills)
    lib/supabase.ts     optional Supabase client + GitHub PKCE login
    lib/cloudSync.ts    push/pull projects+tabs <-> Supabase (maps camel<->snake)
    lib/terminalRegistry.ts  routes PTY output to the right xterm, buffers early bytes
    store/useStore.ts   zustand store + actions (projects, tabs, account)
    store/useChatStore.ts    zustand store for general chats (useStore imports it, never the reverse)
  shared/types.ts       types + IPC channel names shared by both sides
supabase/migrations/    SQL schema + RLS (0001_init, 0002_session_id)
```

## Key design decisions (don't undo without reason)
- **Local-first.** The app always reads/writes `store.json` locally and works fully
  offline. Supabase is optional; when configured it mirrors data for cross-device sync.
- **Projects are per account.** Signed in = that account's projects only (mirrors the
  cloud, incl. deletions via known-id bookkeeping in cloudSync.ts); signed out = this
  computer's. Sign-in offers to move signed-out projects into the account.
- **Multi-file changes go in a git worktree** (e.g. `../agent-fleet-<topic>`): the app
  runs from this folder with HMR, so half-done edits break the user's live app.
- **General chats are agent-neutral and sandboxed.** A chat is answered by whichever
  agent CLI the user has connected (picked per chat; never assume Claude), run headless
  in `userData/chat` with file/shell tools off and web search on (Claude: `--tools
  WebSearch,WebFetch --safe-mode`; Codex: read-only sandbox). Our saved messages are the
  source of truth; the CLI's session is only its memory, and is rebuilt by replaying the
  messages as text when it's gone or the chat switches agent. Chats are per account like
  projects, local only (not in Supabase yet).
- **Skills belong to each agent CLI; we only manage its folders.** Claude Code:
  `<config>/skills`, Codex: `<CODEX_HOME>/skills` (respect CLAUDE_CONFIG_DIR /
  CODEX_HOME). Off = moved to a sibling `skills-disabled/`; remove = Recycle Bin.
  Installing always goes through a stage + review (stageSkills -> installStaged);
  never copy into a skills folder directly. Copies never follow symlinks.
- **Skills in chats are opt-in per chat** (`Chat.skills`). A Claude chat with skills
  drops `--safe-mode`/`--disable-slash-commands` (safe mode also drops plugins) and
  uses `--setting-sources "" --restricted --plugin-dir <copies> --add-dir <copies>`
  with tools WebSearch,WebFetch,Skill,Read: only the chosen skills, Read confined to
  them. Codex chats get the skills' SKILL.md bodies as instructions. Tested with a
  real Claude chat: skill used, its reference file read, an outside file refused.
- **The project view is never unmounted for a chat** (App.tsx hides `main.workspace`):
  TerminalView disposes its xterm on unmount, which would lose the scrollback.
- **The left bar has two sections, Projects and Chats, each with the whole bar** (a
  switch at the top; asked for so a long project list can't crowd the chats). There is
  no separate "section" state: a chat on screen (`useChatStore.activeChatId !== null`)
  means Chats, otherwise Projects. Don't put the two lists in one column again.
- **Even inside a worktree, treat it as live once the user runs the app from it.** Check
  with the process list first. An edit to a store module (`useStore`, `useChatStore`)
  hot-reloads as a fresh store, which resets the running UI (agents show "Resume").
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
- **Commits:** conventional-ish (`feat:`, `fix:`, `chore:`, `docs:`). End with a
  co-author line naming the model that actually did the work, e.g.
  `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
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

## Current status (as of v0.4.0, 2026-11-19)
Working: app builds/runs, projects persist, agent/role tabs, Supabase login, cloud
sync, session resume (used repeatedly while self-hosting; agents come back with
memory), tab persistence across restarts, splash screen.
Added in 0.3–0.4 (see CHANGELOG): side panel (Browser with Annotate + zoom, Fleet
board, agent Messages), image viewer, edit projects/agents, named agents + team
prompt (team.ts), agent/model/effort switcher + Codex support (agents.ts), Settings
→ Agents (sign-in status/login/logout), chat-style Composer with attachments.
Added after 0.6 (unreleased): general chats (chat.ts, chatStore.ts, Chat* components).

Gotchas learned:
- Chat protocol (Claude Code 2.1.328, `claude -p --input-format/--output-format
  stream-json --include-partial-messages`): one process serves many turns; each turn
  ends with a `result` event; text arrives as `stream_event` deltas AND again as an
  `assistant` event per content block; API failures are an `assistant` event flagged
  `is_api_error_message` plus `result.is_error`; Stop is a `control_request` with
  subtype `interrupt`; a missing session is "No conversation found" on resume.
- Codex chat (`codex exec --json`): events `thread.started` / `item.*` / `turn.completed`
  / `turn.failed`; "Reconnecting…" comes as `error` events and is not fatal; its npm
  launcher starts the real binary as a child, so stopping needs a tree kill.
- To check UI work without disturbing the user's running app: load the built renderer
  + real preload in a second Electron process with its own `userData` and a hidden
  window, drive it with `executeJavaScript`, and use `offscreen: true` for screenshots
  (a merely hidden window paints lazily, so captures lag behind).
- Main-process/preload changes need a FULL app restart; renderer changes hot-reload,
  but code that runs at terminal creation needs the terminal recreated.
- The app's agents run inside the app under development; restarting it kills them.
- Windows: `where codex` lists npm's extensionless shell script first (error 193);
  use `resolveCommand` in agents.ts (prefers .exe, runs npm .cmd shims via node).
- Screenshots on the clipboard aren't reliably exposed to paste events; Ctrl+V
  checks the OS clipboard via a sync IPC (clipboard:hasImage).

## Open threads / next steps (START HERE)
(Safe Ctrl+R window reload was considered and dropped: full restarts are only a
dev-time cost; the deployed app won't need them.)
2. **Codex parity.** Codex tabs resume via `codex resume --last` (can pick another
   Codex tab's session in the same folder) and have no named sessions/messaging.
3. **Deployment (deferred until stable).** Package with electron-builder (set
   `appId: com.agentfleet.app` to match `setAppUserModelId` in main/index.ts); add
   electron-updater + GitHub Releases for auto-update (install once, self-updates).
   SemVer/CHANGELOG/tags are already in place to support this.
4. **Skills, next.** Plugin-provided skills aren't listed yet (`claude plugin list
   --json` was empty here, so its format is unverified); marketplace browsing isn't
   built; Codex project skills aren't listed; built-in Claude Code skills are visible
   to a chat that has skills turned on (the chat prompt tells it to use only its own).
5. **General chats, next.** (a) Codex chat has only been exercised up to its sign-in
   error: confirm a real reply, resume and web search once a Codex CLI is signed in.
   (b) Chats are local per account: syncing them needs new Supabase tables. (c) Not
   built: editing/regenerating an earlier message, per-chat effort level, non-image
   attachments, generated titles for Codex chats.
6. **Nice-to-haves:** save terminal transcripts; per-tab "open PR" button; auto-clone a
   project's repo on a new device during restore.
```
