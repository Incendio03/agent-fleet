# ⚓ Agent Fleet

Your own agent management system: a desktop app where each **tab is a terminal
running a Claude Code agent** on its own task. Group tabs under **projects**,
let several agents work the same repo in parallel without colliding (each gets
its own git worktree + branch), and optionally sync your setup to the cloud so
your projects and tabs follow you across devices (and any fresh install).

---

## What it's built from

| Layer | Tech | Why |
|---|---|---|
| App shell | **Electron** | A desktop window around a web UI (like VS Code) |
| UI | **React + TypeScript + xterm.js** | Components + the actual terminal display |
| Backend (Electron main) | **node-pty** | Runs `claude` in a real pseudo-terminal per tab |
| Isolation | **git worktrees** | Each agent works on its own branch/folder |
| Cloud (optional) | **Supabase** (Postgres + Auth + RLS) | Login + sync your setup across devices |
| Code hosting | **GitHub** | Your repos + one branch per agent task |

### How a tab works
`New tab` → backend creates a git **worktree** on a new branch (`agent/<task>`)
→ spawns `claude` inside that folder in a **PTY** → streams its output to an
**xterm.js** terminal you can watch and type into.

---

## Prerequisites

- **Node.js 18+** (you have v24)
- **git** on your PATH
- **Claude Code CLI** (`claude`) installed and logged in once:
  ```powershell
  claude            # first run walks you through sign-in
  ```
  All tabs share that one login automatically.

---

## Run it (development)

```powershell
cd "D:\Projects V2\agent-fleet"
npm install
npm run dev
```

The app window opens. It works **fully offline** — you don't need Supabase to
use it. Create a project (point to any folder that's a git repo), hit **＋** to
launch an agent.

### Using it
1. **+ New project** → browse to a git repo folder (optionally add its GitHub URL).
2. **＋** on the tab bar → give the task a title + prompt, pick:
   - **Model** — Sonnet / Opus / Haiku
   - **Effort** — low / medium / high
   - **Interaction mode**:
     - *Confirm everything* → `claude --permission-mode default`
     - *Confirm risky steps only* → `acceptEdits`
     - *Let it work (autonomous)* → `bypassPermissions`
3. Watch the agent work in the terminal. Switch tabs freely — background agents
   keep running and keep their scrollback.
4. **Close a tab** → stops the agent and removes its worktree folder. The
   **branch is kept** so committed work is never lost; merge it on GitHub via a PR.

---

## Optional: enable cloud login + cross-device sync (Supabase)

This ties your projects/tabs to your account instead of to one machine, so you
can sign in on any device (a second computer, a fresh install, a new machine)
and your setup is there. Skip it and the app still runs fully locally.

### 1. Create the Supabase project
1. Go to <https://supabase.com> → **New project** (free tier is enough).
2. When it's ready, grab two values:
   - **Project URL** — Project Settings → **Data API** (e.g. `https://<ref>.supabase.co`)
   - **Publishable key** — Project Settings → **API Keys** (the `sb_publishable_…`
     key; it's the modern "anon/public" key and is safe to ship. Never use the
     **secret** key in the app — it bypasses RLS.)

### 2. Create the database schema (with security)
Open **SQL Editor**, paste the contents of
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql), and
**Run**. This creates the `projects`, `tabs`, `logs` tables **with Row Level
Security enabled** and "own-rows-only" policies — which is what makes it safe to
ship the public anon key inside the app (a user can only ever see their own data).

> Using the Supabase CLI instead? `npx supabase db push`.

### 3. Set up GitHub login
In Supabase: **Authentication → Providers → GitHub** → enable it, and paste a
GitHub OAuth app's Client ID/Secret (create one at GitHub → Settings →
Developer settings → OAuth Apps). Set the Authorization callback URL to the one
Supabase shows you.

Then, still in Supabase **Authentication → URL Configuration**, add this to the
**Redirect URLs** allow-list so the desktop deep-link works:
```
agentfleet://auth
```

### 4. Point the app at your project
```powershell
cp .env.example .env
```
Edit `.env`:
```
VITE_SUPABASE_URL=https://<your-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```
Restart `npm run dev`. The sidebar footer now shows **Sign in with GitHub**.
It opens your browser, GitHub redirects back via `agentfleet://`, and your
projects/tabs sync. From then on, signing in on any device pulls your setup
down (clone a project's code from its GitHub URL if the local folder isn't on
that machine yet).

> What syncs is the **metadata** — your project list, tasks, and tab settings.
> Each agent's actual code is cloned from GitHub per machine, and a live,
> mid-run agent only exists on the machine it's running on.

---

## Build a distributable

```powershell
npm run build       # type-checks + bundles main/preload/renderer into out/
```
(Packaging into an installer via `electron-builder` can be added later.)

---

## Project structure

```
agent-fleet/
├─ src/
│  ├─ main/                 # Electron main process — the "backend"
│  │  ├─ index.ts           # app bootstrap, window, agentfleet:// protocol
│  │  ├─ ipc.ts             # all IPC handlers (the UI↔backend bridge)
│  │  ├─ sessionManager.ts  # spawns/streams claude in node-pty per tab
│  │  ├─ worktree.ts        # git worktree create/remove per task
│  │  ├─ claude.ts          # detects claude + builds its launch command
│  │  └─ store.ts           # local JSON persistence (offline source of truth)
│  ├─ preload/index.ts      # secure window.fleet bridge
│  ├─ renderer/src/         # React UI
│  │  ├─ App.tsx
│  │  ├─ components/        # Sidebar, TabBar, TerminalView, dialogs, AuthBar
│  │  ├─ lib/               # supabase client, cloudSync, terminalRegistry
│  │  └─ store/useStore.ts  # zustand UI state
│  └─ shared/types.ts       # types + IPC channel names shared by both sides
└─ supabase/migrations/     # SQL schema + RLS policies
```

---

## Security notes
- The renderer is sandboxed; it can only reach the backend through the explicit
  `window.fleet` API in the preload. No direct Node/OS access from the UI.
- Supabase RLS means the shipped anon key can never read another user's rows.
- `.env` is git-ignored — never commit real keys.

## Roadmap ideas
- Merge/PR button per tab (push branch → open GitHub PR)
- Per-tab transcript saving to Supabase Storage
- Re-materialise a cloud project automatically (auto-clone on restore)
- Packaged installers (`electron-builder`)
