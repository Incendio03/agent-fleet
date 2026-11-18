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

[Unreleased]: https://github.com/Incendio03/agent-fleet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Incendio03/agent-fleet/releases/tag/v0.1.0
