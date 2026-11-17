// The panel <-> worker contract, read by src/panel.tsx and src/worker.ts.
export {}

/** One saved version of a screen, as the panel sees it. */
export type VersionView = {
  n: number
  at: number
  /** Image path relative to the plugin folder, or null when no image was captured. */
  png: string | null
  hasStructure: boolean
  /** The prompt Orca submitted, or the agent's task title, when known. */
  task: string | null
}

export type ScreenView = {
  key: string
  name: string
  fileKey: string
  nodeId: string
  /** Newest last. */
  versions: VersionView[]
}

export type HistoryView = {
  workspaceId: string | null
  screens: ScreenView[]
  /** Screens saved by the most recent run, first one is the default. */
  latestRun: string[]
  lastError: { message: string; at: number } | null
  /** True while the agent that made the newest version is working. */
  agentBusy: boolean
  /** Whether a REST fallback token is available (env or secrets). */
  hasToken: boolean
}

export type DiffView = {
  /** One plain sentence, or null when either side has no structure. */
  summary: string | null
  items: { name: string; detail: string }[]
}

/** What the panel sends to identify the focused workspace. */
export type WorkspaceHint = { branch: string; displayName: string } | null

declare module 'orca' {
  interface PluginRequests {
    'history.get': { input: { hint: WorkspaceHint }; output: HistoryView }
    'diff.get': {
      input: { workspaceId: string | null; screenKey: string; before: number; after: number }
      output: DiffView
    }
    'agent.restore': {
      input: { workspaceId: string | null; screenKey: string; version: number }
      output: { sent: boolean; reason?: string }
    }
    'agent.explain': {
      input: { workspaceId: string | null; screenKey: string; before: number; after: number }
      output: { sent: boolean; reason?: string }
    }
    'error.dismiss': { output: null }
    'token.set': { input: { token: string }; output: { ok: boolean } }
  }
  interface PluginPanelEvents {
    history_updated: { workspaceId: string | null }
    capture_error: { message: string }
  }
}
