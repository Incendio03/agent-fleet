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
### Added
- **Chat-style message box** under each agent's terminal: normal text editing
  (new lines with Shift+Enter, select all, copy/paste, undo), Enter sends the
  whole message (multi-line as one bracketed paste), per-tab drafts. Ctrl+V pastes
  images (saved to `.fleet/shots/`, path inserted); dropping files inserts their
  paths. Esc reaches the agent (interrupt); with an empty box, ↑ ↓ Enter and
  Shift+Tab do too, for the agent's menus. The agent/model/effort bar sits under it.
- Ctrl+C in a terminal copies the selection when there is one.
- Image paste falls back to the OS clipboard, so bitmap-only clipboards (Windows
  clipboard history, Win+V) paste too, in the message box and in terminals (the
  image is saved and its path inserted). Empty pastes say what was on the clipboard.

### Removed
- The default File / Edit / View / Window / Help menu bar (DevTools stays on
  F12 / Ctrl+Shift+I in dev).

### Added
- Confirmation before signing out of Agent Fleet (cloud account).
- **Settings window** (⚙ Settings at the bottom of the sidebar), with sections;
  the first is **Agents**. Shows each agent CLI's version
  and sign-in state (from `claude auth status` / `codex login status`). Sign in,
  switch account, or sign out; sign-in runs the CLI's own login flow in an embedded
  terminal, so credentials stay with each CLI. Not-installed agents show an install
  command and setup guide.
- **Agent / Model / Effort bar above each terminal.** Switch the tab's agent CLI,
  model and effort from dropdowns. Options are detected on this machine: installed
  agents (Claude Code, Codex), Claude's model aliases + effort levels from
  `claude --help`, Codex models + per-model efforts from `~/.codex/models_cache.json`.
  A running agent restarts to apply: same agent resumes the conversation, a
  different agent starts fresh. Also in the New/Edit agent dialog.
- **Codex support** as a tab agent (model, reasoning effort, approval mode mapped
  from the interaction mode; resume via `codex resume --last`). Named sessions and
  teammate messaging remain Claude Code only.
- **Named agents.** Each agent's Claude session is named `<project>-<role>` (e.g.
  `agent-fleet-code-reviewer`) via `--name`, which is the address teammates use with
  Claude Code's built-in SendMessage. Each agent also gets a team prompt
  (`--append-system-prompt`) with its role, teammates' names and the board.
- **Fleet board.** `<project>/.fleet/board.md`, a shared notes file every agent is
  told to read and keep its own section of. Editable in the side panel's Board tab.
- **Messages panel.** The side panel's Messages tab shows agent-to-agent messages
  (read from each agent's Claude transcript) and the team roster.
- The 🌐 side panel now has Browser / Board / Messages tabs.

### Changed
- Startup shows a full-window splash screen (logo, name, progress bar, version)
  until projects are fully loaded, including the cloud restore when signed in
  (capped at 8s), then fades into the app, instead of flashing the Welcome screen
  and then popping projects in.

### Fixed
- Codex on Windows: "Cannot create process, error code: 193" on sign-in/launch, and
  missing version / "Not signed in". `where codex` lists npm's extensionless shell
  script first; commands now prefer a real .exe and run npm .cmd shims via Node.
- Sign-in / agent status errors are shown instead of failing silently.
## [0.3.2] — 2026-11-19
### Fixed
- Resumed/new agents drew at 80 columns (stray lines, prompt box mid-screen): the
  terminal now re-sends its real size whenever its agent (re)starts. 0.3.1's
  "skip unchanged size" check had suppressed that resend.

## [0.3.1] â€” 2026-11-18
### Fixed
- Garbled terminal (prompt box drawn mid-screen) after resizing: terminal resizes
  are now debounced so Claude Code redraws once at the final size, and hidden tabs
  no longer send bogus sizes.

## [0.3.0] â€” 2026-11-18
### Added
- **Side browser panel** (one per window, toggle with ðŸŒ in the tab bar, resizable
  splitter). **Annotate** works like a snipping tool: drag a box on the live page,
  add an optional note, send. The full screenshot (box + note drawn in) is saved to
  `<project>/.fleet/shots/` (git-ignored) and its path typed into the active agent.
- **Click images in the terminal to view them.** `[Image #N]` placeholders (pasted,
  sent or not) and image file paths are clickable and open an in-app viewer
  (fit / actual size, Show in folder).
- **Side browser zoom:** Ctrl + / Ctrl âˆ’ / Ctrl 0 and Ctrl + mouse wheel, plus a â‹®
  menu in the browser bar with âˆ’ / % / + controls (click % to reset).
- **Edit projects and agents.** â‹® or right-click on a project (sidebar) edits name, folder and
  GitHub URL; tabs following the old folder move with it. â‹®, right-click or
  double-click on a tab edits name, instructions, model, effort and mode; settings apply
  on the agent's next launch/resume. Changes sync to the cloud when signed in.

### Fixed
- "A JavaScript error occurred in the main process" on quit: dying agent processes
  sent events to the already-destroyed window.
- Terminal text no longer runs under the scrollbar (FitAddon was measuring the
  host's padding as usable width).

## [0.2.2] â€” 2026-11-18
### Fixed
- **"Project not found" when creating a tab on a cloud-synced project.** Cloud
  restore populated the UI but not the backend store, so `tab:create` (which
  validates against the local store) couldn't find the project. Cloud-restored
  projects/tabs are now persisted into the local store via a new `store:import`
  IPC, and projects are deduped by folder path so the same folder isn't listed
  twice.

## [0.2.1] â€” 2026-11-18
### Fixed
- **Blank terminal after restart.** A restored tab could read as `running` even
  though no agent process existed, so the Resume overlay didn't appear and the
  terminal showed blank. "Is this tab live?" is now tracked from actual sessions
  in the current app run (`liveTabIds`), not the persisted status â€” so restored
  tabs reliably show the Resume overlay.
### Added
- `CLAUDE.md` â€” project context/handoff file auto-loaded by Claude Code.

## [0.2.0] â€” 2026-11-18
### Changed
- **Tabs are now agents/roles, not one-off tasks.** The new-agent dialog asks for
  an **agent name/role** (e.g. "Software Engineer", "Project Manager") with
  optional role instructions, instead of a required task. The persona persists
  across restarts via session-resume.
- **Removed forced git worktrees on tab creation.** Agents now run directly in
  the project folder and create branches themselves when you ask. (Worktree
  isolation remains available in the backend via an opt-in `isolate` flag.)

## [0.1.0] â€” 2026-11-18
First working version.

### Added
- **Multi-tab agent workspace** â€” Electron + React + TypeScript desktop app where
  each tab is a terminal (`xterm.js`) running a Claude Code agent.
- **Projects** â€” add any folder as a project (a single git repo *or* a folder
  containing several repos).
- **Agent tabs** â€” launch `claude` per tab with selectable **model**, **effort**,
  and **interaction mode** (confirm everything / confirm risky only / autonomous),
  mapped to the CLI's `--permission-mode`.
- **Git worktree isolation** â€” for git-repo projects, each agent gets its own
  branch + worktree so parallel agents don't collide; non-git projects run the
  agent directly in the folder (never deleted on close).
- **Session resume** â€” each tab has a stable Claude session id; a Resume action
  re-attaches the saved conversation (`claude --resume`) with full memory.
- **CLI capability detection** â€” supported flags are detected from
  `claude --help`, so the app adapts to the installed Claude Code version.
- **Cloud sync (optional)** â€” Supabase (Postgres + Auth + RLS) with GitHub login
  via a loopback OAuth redirect; projects/tabs sync across devices.
- **Local-first persistence** â€” projects/tabs saved to a local JSON store; the
  app works fully offline when Supabase isn't configured.

[Unreleased]: https://github.com/Incendio03/agent-fleet/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Incendio03/agent-fleet/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Incendio03/agent-fleet/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Incendio03/agent-fleet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Incendio03/agent-fleet/releases/tag/v0.1.0
