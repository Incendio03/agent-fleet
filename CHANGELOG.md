# Changelog

All notable changes to Agent Fleet are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/), and the project
uses [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`). While
pre-`1.0`, a **minor** bump means a new feature and a **patch** means a fix.

## How we version (early-stage workflow)
1. Make your changes and update the **[Unreleased]** section below.
2. Bump the version + create a git tag in one step:
   ```powershell
   npm version patch   # bug fixes      -> 0.1.0 -> 0.1.1
   npm version minor   # new feature     -> 0.1.1 -> 0.2.0
   npm version major   # breaking change -> 0.x   -> 1.0.0 (post-1.0)
   ```
   This updates `package.json`, commits it, and tags it (e.g. `v0.2.0`).
3. Move the `[Unreleased]` notes under the new version heading.
4. Push with tags: `git push --follow-tags`.

The running version is shown in the app's sidebar header.

---

## [Unreleased]

## [0.2.2] — 2026-11-18
### Fixed
- **"Project not found" when creating a tab on a cloud-synced project.** Cloud
  restore populated the UI but not the backend store, so `tab:create` (which
  validates against the local store) couldn't find the project. Cloud-restored
  projects/tabs are now persisted into the local store via a new `store:import`
  IPC, and projects are deduped by folder path so the same folder isn't listed
  twice.

## [0.2.1] — 2026-11-18
### Fixed
- **Blank terminal after restart.** A restored tab could read as `running` even
  though no agent process existed, so the Resume overlay didn't appear and the
  terminal showed blank. "Is this tab live?" is now tracked from actual sessions
  in the current app run (`liveTabIds`), not the persisted status — so restored
  tabs reliably show the Resume overlay.
### Added
- `CLAUDE.md` — project context/handoff file auto-loaded by Claude Code.

## [0.2.0] — 2026-11-18
### Changed
- **Tabs are now agents/roles, not one-off tasks.** The new-agent dialog asks for
  an **agent name/role** (e.g. "Software Engineer", "Project Manager") with
  optional role instructions, instead of a required task. The persona persists
  across restarts via session-resume.
- **Removed forced git worktrees on tab creation.** Agents now run directly in
  the project folder and create branches themselves when you ask. (Worktree
  isolation remains available in the backend via an opt-in `isolate` flag.)

## [0.1.0] — 2026-11-18
First working version.

### Added
- **Multi-tab agent workspace** — Electron + React + TypeScript desktop app where
  each tab is a terminal (`xterm.js`) running a Claude Code agent.
- **Projects** — add any folder as a project (a single git repo *or* a folder
  containing several repos).
- **Agent tabs** — launch `claude` per tab with selectable **model**, **effort**,
  and **interaction mode** (confirm everything / confirm risky only / autonomous),
  mapped to the CLI's `--permission-mode`.
- **Git worktree isolation** — for git-repo projects, each agent gets its own
  branch + worktree so parallel agents don't collide; non-git projects run the
  agent directly in the folder (never deleted on close).
- **Session resume** — each tab has a stable Claude session id; a Resume action
  re-attaches the saved conversation (`claude --resume`) with full memory.
- **CLI capability detection** — supported flags are detected from
  `claude --help`, so the app adapts to the installed Claude Code version.
- **Cloud sync (optional)** — Supabase (Postgres + Auth + RLS) with GitHub login
  via a loopback OAuth redirect; projects/tabs sync across devices.
- **Local-first persistence** — projects/tabs saved to a local JSON store; the
  app works fully offline when Supabase isn't configured.

[Unreleased]: https://github.com/Incendio03/agent-fleet/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Incendio03/agent-fleet/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Incendio03/agent-fleet/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Incendio03/agent-fleet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Incendio03/agent-fleet/releases/tag/v0.1.0
