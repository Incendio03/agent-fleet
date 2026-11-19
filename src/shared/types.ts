// Types shared between the main process (backend) and the renderer (UI).
// Keeping them here means both sides agree on the shape of the data that
// crosses the IPC bridge.

/** How much the agent is allowed to do on its own. Maps to claude --permission-mode. */
export type PermissionMode =
  | 'default' // confirm every action
  | 'acceptEdits' // auto-accept file edits, confirm risky commands
  | 'bypassPermissions' // fully autonomous, no prompts

/** Which agent CLI runs a tab. */
export type AgentKind = 'claude' | 'codex'

/** Model id for a tab (detected per agent — e.g. 'opus' for Claude Code, a slug for Codex). */
export type ModelAlias = string

/** Reasoning effort for a tab (detected per agent/model, e.g. low…max). */
export type EffortLevel = string

/** An agent CLI as detected on this machine, with what it supports. */
export interface AgentInfo {
  id: AgentKind
  label: string
  /** Installed and runnable here. */
  available: boolean
  models: { id: string; label: string; efforts: string[] }[]
  /** All effort levels this agent accepts (union over models). */
  efforts: string[]
  supportsResume: boolean
  /** Named sessions + teammate messaging (Claude Code only today). */
  supportsTeam: boolean
}

/** A project is a pointer to a git repo on disk + its remote. */
export interface Project {
  id: string
  name: string
  /** Absolute path to the repo root on this machine. */
  localPath: string
  /** GitHub remote URL, if any (used to re-clone the repo on another machine). */
  githubUrl?: string
  createdAt: number
}

/** The live run-state of a tab's agent process. */
export type TabStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'

/** A tab = one agent session working on one task inside one project. */
export interface Tab {
  id: string
  projectId: string
  title: string
  /** Agent CLI running this tab (missing = 'claude', for older tabs). */
  agent?: AgentKind
  /** The task prompt the agent was seeded with. */
  task: string
  model: ModelAlias
  effort: EffortLevel
  permissionMode: PermissionMode
  /** Git branch this tab's worktree is checked out on. */
  branch: string
  /** Absolute path to this tab's git worktree folder. */
  worktreePath: string
  /**
   * Stable Claude Code session id for this tab. Assigned at creation and passed
   * to `claude --session-id` so the conversation can later be re-attached with
   * `claude --resume <sessionId>` — restoring the agent's full memory.
   */
  sessionId: string
  status: TabStatus
  /** Process exit code, once the agent process has exited. */
  exitCode?: number
  createdAt: number
}

/** Options the UI sends when asking the backend to spawn a new agent tab. */
export interface CreateTabOptions {
  projectId: string
  /** The agent's name/role, e.g. "Software Engineer". Used as the tab label. */
  title: string
  agent?: AgentKind
  /** Optional role / initial instructions to seed the agent with (may be empty). */
  task: string
  model: ModelAlias
  effort: EffortLevel
  permissionMode: PermissionMode
  /**
   * When true (and the project is a git repo), give this agent its own git
   * worktree + branch. When false, it runs directly in the project folder.
   */
  isolate: boolean
}

/** Options for creating a new project. */
export interface CreateProjectOptions {
  name: string
  localPath: string
  githubUrl?: string
}

/** Editable fields of a project. */
export interface UpdateProjectOptions {
  name: string
  localPath: string
  githubUrl?: string
}

/** Editable fields of an agent tab (model/effort/mode apply on next launch/resume). */
export interface UpdateTabOptions {
  title: string
  agent?: AgentKind
  task: string
  model: ModelAlias
  effort: EffortLevel
  permissionMode: PermissionMode
}

/** App preferences kept by the main process (main/prefs.ts). */
export interface AppPrefs {
  /**
   * Run Claude agents with Claude Code's classic interface ("tui": "default"),
   * so the conversation lives in terminal scrollback (real scrollbar, wheel,
   * selection). Off = inherit the user's Claude Code setting (e.g. fullscreen).
   */
  classicScrolling: boolean
}

/** What an agent just did, reported by its hooks (see main/attention.ts). */
export interface TabActivity {
  tabId: string
  /** working = started a turn; done = finished its turn; input = needs you. */
  kind: 'working' | 'done' | 'input'
  /** e.g. "Claude needs your permission to use Bash". */
  message?: string
}

/** Install + sign-in state of an agent CLI (from its own status command). */
export interface AgentStatus {
  id: AgentKind
  installed: boolean
  version?: string
  loggedIn: boolean
  /** e.g. "you@example.com · Claude account" or "Logged in using ChatGPT". */
  account?: string
  /** Suggested install command and docs link (shown when not installed). */
  install?: string
  docs?: string
}

/** One agent-to-agent message, read from the sender's Claude transcript. */
export interface FleetMessage {
  id: string
  ts: number
  fromTabId: string
  /** Sender's session name. */
  from: string
  /** Recipient as the sender addressed it (a session name). */
  to: string
  text: string
}

// ---- IPC channel names (single source of truth) --------------------------

export const IPC = {
  // renderer -> main (invoke/handle, returns a value)
  projectList: 'project:list',
  projectCreate: 'project:create',
  projectRemove: 'project:remove',
  projectUpdate: 'project:update',
  tabList: 'tab:list',
  tabCreate: 'tab:create',
  tabResume: 'tab:resume',
  tabClose: 'tab:close',
  tabRestart: 'tab:restart', // stop + relaunch an agent (to apply new settings)
  agentsList: 'agents:list', // detected agent CLIs + their models/efforts
  agentStatus: 'agents:status', // installed/version/signed-in for one agent
  agentLogin: 'agents:login', // run the agent's sign-in in a utility terminal
  agentLogout: 'agents:logout',
  tabKill: 'tab:kill', // stop a utility terminal (e.g. a sign-in) without removing anything
  tabUpdate: 'tab:update',
  tabInput: 'tab:input',
  tabResize: 'tab:resize',
  dialogPickFolder: 'dialog:pickFolder',
  openExternal: 'app:openExternal',
  cloneRepo: 'project:clone',
  storeImport: 'store:import',
  browserCapture: 'browser:capture', // screenshot a <webview> by webContentsId
  clipboardImage: 'clipboard:image', // system clipboard image as PNG data URL (or null)
  clipboardHasImage: 'clipboard:hasImage', // SYNC: is there an image on the OS clipboard?
  clipboardFormats: 'clipboard:formats', // formats on the system clipboard (diagnostics)
  shotSave: 'shot:save', // save an annotated PNG into the project folder
  boardRead: 'board:read', // project's .fleet/board.md
  boardWrite: 'board:write',
  messagesList: 'messages:list', // agent-to-agent messages in a project
  sessionNames: 'team:names', // tabId -> Claude session name
  imageResolve: 'image:resolve', // [Image #N] in a tab -> file path on disk
  imageRead: 'image:read', // image file -> data URL for the viewer
  imageReveal: 'image:reveal', // show an image file in Explorer
  // main -> renderer (events, pushed from backend)
  tabData: 'tab:data', // terminal output chunk
  tabExit: 'tab:exit', // process exited
  tabStatus: 'tab:status', // status changed
  prefsGet: 'prefs:get',
  prefsSet: 'prefs:set',
  tabActivity: 'tab:activity', // agent hook event (working / done / needs input)
  windowFocus: 'app:focusWindow', // bring the window to the front (notification click)
  browserZoom: 'browser:zoom', // side-browser zoom changed (percent)
  browserOpenTab: 'browser:openTab', // a page asked for a new window -> open a browser tab
  browserShortcut: 'browser:shortcut', // Ctrl+T / Ctrl+W pressed inside a page
  authCallback: 'auth:callback' // OAuth deep-link redirect came back
} as const
