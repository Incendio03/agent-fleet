// Types shared between the main process (backend) and the renderer (UI).
// Keeping them here means both sides agree on the shape of the data that
// crosses the IPC bridge.

/** How much the agent is allowed to do on its own. Maps to claude --permission-mode. */
export type PermissionMode =
  | 'default' // confirm every action
  | 'acceptEdits' // auto-accept file edits, confirm risky commands
  | 'bypassPermissions' // fully autonomous, no prompts

/** Claude model choice for a tab. */
export type ModelAlias = 'opus' | 'sonnet' | 'haiku'

/** Reasoning effort for a tab. Maps to claude --effort. */
export type EffortLevel = 'low' | 'medium' | 'high'

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
  task: string
  model: ModelAlias
  effort: EffortLevel
  permissionMode: PermissionMode
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
  tabUpdate: 'tab:update',
  tabInput: 'tab:input',
  tabResize: 'tab:resize',
  dialogPickFolder: 'dialog:pickFolder',
  openExternal: 'app:openExternal',
  cloneRepo: 'project:clone',
  storeImport: 'store:import',
  browserCapture: 'browser:capture', // screenshot a <webview> by webContentsId
  shotSave: 'shot:save', // save an annotated PNG into the project folder
  imageResolve: 'image:resolve', // [Image #N] in a tab -> file path on disk
  imageRead: 'image:read', // image file -> data URL for the viewer
  imageReveal: 'image:reveal', // show an image file in Explorer
  // main -> renderer (events, pushed from backend)
  tabData: 'tab:data', // terminal output chunk
  tabExit: 'tab:exit', // process exited
  tabStatus: 'tab:status', // status changed
  browserZoom: 'browser:zoom', // side-browser zoom changed (percent)
  authCallback: 'auth:callback' // OAuth deep-link redirect came back
} as const
