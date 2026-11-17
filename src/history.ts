// The saved history and the in-progress agent runs, as plain JSON kept in orca.storage.
// Pure functions: the worker does the file and network work around them.

export const MAX_VERSIONS = 20
export const NO_WORKSPACE = '_none'

export type StoredVersion = {
  n: number
  at: number
  /** Relative to the plugin folder. */
  png: string | null
  json: string | null
  task: string | null
  terminalId: string | null
}

export type StoredScreen = {
  fileKey: string
  nodeId: string
  name: string
  /** The next version number; never reused after old versions are deleted. */
  next: number
  versions: StoredVersion[]
}

export type WorkspaceHistory = {
  screens: Record<string, StoredScreen>
  latestRun: string[]
}

export type History = { workspaces: Record<string, WorkspaceHistory> }

export const emptyHistory = (): History => ({ workspaces: {} })

export const screenKey = (fileKey: string, nodeId: string) => `${fileKey}/${nodeId}`

export function asHistory(value: unknown): History {
  if (value && typeof value === 'object' && 'workspaces' in value) return value as History
  return emptyHistory()
}

/** Adds a version (mutating `h`), returns its number and the versions pushed out by the limit. */
export function addVersion(
  h: History,
  workspaceKey: string,
  screen: { fileKey: string; nodeId: string; name: string },
  version: Omit<StoredVersion, 'n'>
): { n: number; evicted: StoredVersion[] } {
  const ws = (h.workspaces[workspaceKey] ??= { screens: {}, latestRun: [] })
  const key = screenKey(screen.fileKey, screen.nodeId)
  const s = (ws.screens[key] ??= { ...screen, next: 1, versions: [] })
  if (screen.name) s.name = screen.name
  const n = s.next
  s.next += 1
  s.versions.push({ ...version, n })
  const evicted = s.versions.length > MAX_VERSIONS ? s.versions.splice(0, s.versions.length - MAX_VERSIONS) : []
  return { n, evicted }
}

/** The file paths a version will use, relative to the plugin folder. */
export function versionPaths(fileKey: string, safeNode: string, n: number) {
  const dir = `captures/${fileKey.replace(/[^0-9A-Za-z]/g, '')}/${safeNode}`
  return { dir, png: `${dir}/v${n}.png`, json: `${dir}/v${n}.json` }
}

/** The agent-readable copy: one Markdown table of every saved version in a workspace. */
export function historyMarkdown(ws: WorkspaceHistory, pluginRoot: string): string {
  const abs = (p: string | null) => (p ? `${pluginRoot}/${p}` : '—')
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  const lines = [
    '<!-- Written by the Before / After Orca plugin. Do not edit: it is regenerated after each capture. -->',
    '# Figma screen history',
    '',
    'Saved versions of Figma screens changed by agents in this workspace. Each PNG shows how the',
    'screen looked; each JSON holds its layer structure. To restore a version, rebuild the screen',
    'to match both. Refer to a version as "<Screen> v<N>".',
    '',
    '| Screen | Version | Time | PNG | JSON | Task |',
    '| --- | --- | --- | --- | --- | --- |'
  ]
  const screens = Object.values(ws.screens).sort((a, b) => a.name.localeCompare(b.name))
  for (const s of screens) {
    for (const v of [...s.versions].reverse()) {
      lines.push(
        `| ${cell(s.name)} (${s.nodeId}) | v${v.n} | ${new Date(v.at).toISOString()} | ${abs(v.png)} | ${abs(v.json)} | ${cell(v.task ?? '')} |`
      )
    }
  }
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------
// In-progress runs: what one agent did in Figma since it last finished.

export type RunNode = {
  fileKey: string
  name?: string
  /** A screenshot saved to a pending file, and when in the run it was taken. */
  shot?: { path: string; seq: number }
  meta?: { text: string; seq: number }
}

export type Run = {
  workspaceId: string | null
  terminalId: string | null
  startedAt: number
  seq: number
  /** Sequence number of the last Figma write; 0 when the run changed nothing. */
  lastWriteSeq: number
  fileKey: string | null
  task: string | null
  nodes: Record<string, RunNode>
}

export type Runs = Record<string, Run>

export const runKeyOf = (terminalId: string | null | undefined, workspaceId: string | null | undefined) =>
  terminalId ? `t:${terminalId}` : `w:${workspaceId ?? NO_WORKSPACE}`

export function newRun(workspaceId: string | null, terminalId: string | null, now: number): Run {
  return { workspaceId, terminalId, startedAt: now, seq: 0, lastWriteSeq: 0, fileKey: null, task: null, nodes: {} }
}

/**
 * The screens to save when a run that wrote to Figma ends: every node the agent screenshotted or
 * outlined during the run. Node ids that only appear in write calls are not screens (they are
 * often dozens of child layers). A screenshot or outline taken before the last write shows the old
 * state, so only `fresh` ones count; a stale screen can still get an image from the REST fallback.
 */
export function nodesToCapture(
  run: Run
): { nodeId: string; node: RunNode; freshShot: boolean; freshMeta: boolean }[] {
  return Object.entries(run.nodes)
    .filter(([, node]) => node.shot || node.meta)
    .map(([nodeId, node]) => ({
      nodeId,
      node,
      freshShot: !!node.shot && node.shot.seq > run.lastWriteSeq,
      freshMeta: !!node.meta && node.meta.seq > run.lastWriteSeq
    }))
}
