// The plugin's worker: a Node process Orca starts for hooks, events and panel requests. It
// watches the agent's Figma MCP calls, saves the screens a run changed when the agent finishes,
// keeps the history in orca.storage, and answers the panel. A reload drops memory, so everything
// that must last is in storage.
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OrcaWorkerApi } from 'orca/worker'
import type { DiffView, HistoryView, ScreenView, WorkspaceHint } from './protocol'
import { type ImageRef, parseFigmaCall, safeNodeId } from './figma'
import { type Layer, diffLayers, layerFromMetadata, layerFromRest, summarize } from './diff'
import {
  type History,
  NO_WORKSPACE,
  type Run,
  type Runs,
  type StoredScreen,
  addVersion,
  asHistory,
  historyMarkdown,
  newRun,
  nodesToCapture,
  runKeyOf,
  versionPaths
} from './history'

/** Swappable in tests. */
export const config = {
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
  now: () => Date.now(),
  env: process.env as Record<string, string | undefined>
}

const HISTORY = 'history'
const RUNS = 'runs'
const LAST_ERROR = 'lastError'
const TOKEN = 'figmaToken'
const HISTORY_FILE = '.orca-figma-history.md'
const IDLE = new Set(['done', 'waiting'])

let orca: OrcaWorkerApi

// One queue for every storage read-modify-write, so quick tool calls never lose an update.
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn)
  chain = p.catch(() => undefined)
  return p
}

// Hook work runs after Orca moves on; tests wait for it with `settled()`.
const inflight = new Set<Promise<unknown>>()
function track(p: Promise<unknown>): void {
  inflight.add(p)
  void p.finally(() => inflight.delete(p))
}
export async function settled(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight])
  await chain
}

const abs = (rel: string) => join(config.root, ...rel.split('/'))
const loadHistory = async (): Promise<History> => asHistory(await orca.storage.get(HISTORY))
const loadRuns = async (): Promise<Runs> => ((await orca.storage.get(RUNS)) as Runs | null) ?? {}

async function exists(rel: string): Promise<boolean> {
  try {
    await stat(abs(rel))
    return true
  } catch {
    return false
  }
}

/** png, jpg or webp from the first bytes; null when it is none of them. */
function imageExt(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg'
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  return null
}

async function imageBytes(ref: ImageRef, headers?: Record<string, string>): Promise<Uint8Array> {
  if ('base64' in ref) return Uint8Array.from(Buffer.from(ref.base64.replace(/^data:[^,]+,/, ''), 'base64'))
  const res = await config.fetch(ref.url, headers ? { headers } : undefined)
  if (!res.ok) throw new Error(`Image download failed (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

async function setError(message: string): Promise<void> {
  orca.log(`capture error: ${message}`)
  await orca.storage.set(LAST_ERROR, { message, at: config.now() })
  orca.panels.post('capture_error', { message })
}

async function figmaToken(): Promise<string | null> {
  return config.env.FIGMA_ACCESS_TOKEN || (await orca.secrets.get(TOKEN)) || null
}

// ---------------------------------------------------------------------------------------------
// Watching the agent

async function onToolCall(e: {
  tool: string
  input: unknown
  output?: unknown
  terminalId?: string
  workspaceId: string | null
}): Promise<void> {
  const call = parseFigmaCall(e.tool, e.input, e.output)
  if (!call) return
  orca.log(
    `figma ${call.kind} ${call.tool} file=${call.fileKey ?? '?'} nodes=${call.nodeIds.slice(0, 5).join(',')} ` +
      `image=${call.image ? ('url' in call.image ? 'url' : 'inline') : 'none'} terminal=${e.terminalId ?? '?'}`
  )
  if (call.kind === 'screenshot' && !call.image) {
    orca.log(`screenshot output had no image: ${JSON.stringify(e.output ?? null).slice(0, 400)}`)
  }
  // Arrival time orders the calls: a screenshot taken before a later write shows the old state.
  const seq = config.now() * 1000 + (counter = (counter + 1) % 1000)
  let pending: string | null = null
  if (call.kind === 'screenshot' && call.image && call.nodeIds[0]) {
    try {
      const bytes = await imageBytes(call.image)
      const ext = imageExt(bytes)
      if (ext) {
        pending = `captures/_pending/${seq}-${safeNodeId(call.nodeIds[0])}.${ext}`
        await mkdir(dirname(abs(pending)), { recursive: true })
        await writeFile(abs(pending), bytes)
      }
    } catch (err) {
      // The URL is short-lived; a missed one only means this screenshot is not saved.
      orca.log(`screenshot download failed: ${String(err)}`)
    }
  }
  await locked(async () => {
    const runs = await loadRuns()
    const key = runKeyOf(e.terminalId, e.workspaceId)
    const run = (runs[key] ??= newRun(e.workspaceId, e.terminalId ?? null, config.now()))
    run.seq = Math.max(run.seq, seq)
    if (call.fileKey) run.fileKey = call.fileKey
    if (call.kind === 'write') run.lastWriteSeq = Math.max(run.lastWriteSeq, seq)
    const fileKey = call.fileKey ?? run.fileKey
    if (fileKey && call.nodeIds[0] && (call.kind === 'screenshot' || call.kind === 'metadata')) {
      const node = (run.nodes[call.nodeIds[0]] ??= { fileKey })
      if (pending) {
        if (node.shot) await rm(abs(node.shot.path), { force: true })
        node.shot = { path: pending, seq }
      }
      if (call.metadata) {
        node.meta = { text: call.metadata, seq }
        node.name = layerFromMetadata(call.metadata)?.name || node.name
      }
    }
    await orca.storage.set(RUNS, runs as never)
  })
}
let counter = 0

async function onPrompt(e: { terminalId: string; prompt: string }): Promise<void> {
  await locked(async () => {
    const runs = await loadRuns()
    const key = runKeyOf(e.terminalId, null)
    const run = (runs[key] ??= newRun(null, e.terminalId, config.now()))
    run.task = e.prompt.slice(0, 500)
    await orca.storage.set(RUNS, runs as never)
  })
}

async function onStatus(e: {
  workspaceId: string | null
  terminalId?: string
  title?: string
  state: string
}): Promise<void> {
  const finished = await locked(async () => {
    const runs = await loadRuns()
    const exact = runKeyOf(e.terminalId, e.workspaceId)
    const keys = runs[exact]
      ? [exact]
      : e.terminalId
        ? []
        : Object.keys(runs).filter((k) => runs[k]?.workspaceId === e.workspaceId)
    for (const k of keys) {
      const run = runs[k] as Run
      if (run.workspaceId === null) run.workspaceId = e.workspaceId
      if (!run.task && e.title) run.task = e.title
    }
    if (!IDLE.has(e.state)) {
      if (keys.length) await orca.storage.set(RUNS, runs as never)
      return []
    }
    const done = keys.map((k) => runs[k] as Run)
    for (const k of keys) delete runs[k]
    await orca.storage.set(RUNS, runs as never)
    return done
  })
  for (const run of finished) {
    orca.log(`run finished: wrote=${run.lastWriteSeq > 0} screens=${nodesToCapture(run).length}`)
    await finishRun(run)
  }
}

// ---------------------------------------------------------------------------------------------
// Saving a finished run

type RestImages = { images?: Record<string, string | null>; err?: string | null }
type RestNodes = { nodes?: Record<string, { document?: unknown } | null> }

async function restGet<T>(path: string, token: string): Promise<T> {
  const res = await config.fetch(`https://api.figma.com${path}`, { headers: { 'X-Figma-Token': token } })
  if (res.status === 429) {
    const after = Number(res.headers.get('retry-after'))
    const when = Number.isFinite(after) && after > 0 ? ` Try again in ${Math.ceil(after / 60)} min.` : ''
    throw new Error(`Figma’s usage limit was reached, so this run’s screens were not all saved.${when}`)
  }
  if (res.status === 403) throw new Error('Figma refused the access token. Check it in Settings.')
  if (!res.ok) throw new Error(`Figma API error (${res.status}).`)
  return (await res.json()) as T
}

async function finishRun(run: Run): Promise<void> {
  const screens = nodesToCapture(run)
  const pendingFiles = Object.values(run.nodes).flatMap((n) => (n.shot ? [n.shot.path] : []))
  if (run.lastWriteSeq === 0) {
    await Promise.all(pendingFiles.map((p) => rm(abs(p), { force: true })))
    return
  }
  if (!screens.length) {
    await setError(
      'The agent changed Figma but took no screenshots, so nothing was saved. Add the capture line to your agent instructions.'
    )
    return
  }

  // REST fallback for screens without a fresh image or structure, when a token exists.
  const restImages = new Map<string, Uint8Array>()
  const restLayers = new Map<string, Layer>()
  const token = await figmaToken()
  const needImage = screens.filter((s) => !s.freshShot)
  const needStruct = screens.filter((s) => !s.freshMeta)
  if (token && (needImage.length || needStruct.length)) {
    const byFile = new Map<string, string[]>()
    for (const s of screens) byFile.set(s.node.fileKey, [...(byFile.get(s.node.fileKey) ?? []), s.nodeId])
    try {
      for (const [fileKey, ids] of byFile) {
        const imgIds = ids.filter((id) => needImage.some((s) => s.nodeId === id))
        const structIds = ids.filter((id) => needStruct.some((s) => s.nodeId === id))
        const [imgs, nodes] = await Promise.all([
          imgIds.length
            ? restGet<RestImages>(`/v1/images/${fileKey}?ids=${encodeURIComponent(imgIds.join(','))}&format=png&scale=1`, token)
            : null,
          structIds.length
            ? restGet<RestNodes>(`/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(structIds.join(','))}`, token)
            : null
        ])
        for (const [id, url] of Object.entries(imgs?.images ?? {})) {
          if (url) restImages.set(id, await imageBytes({ url }))
        }
        for (const [id, entry] of Object.entries(nodes?.nodes ?? {})) {
          if (entry?.document) restLayers.set(id, layerFromRest(entry.document as never))
        }
      }
    } catch (err) {
      await setError(err instanceof Error ? err.message : String(err))
    }
  }

  const workspaceKey = run.workspaceId ?? NO_WORKSPACE
  const saved: string[] = []
  await locked(async () => {
    const h = await loadHistory()
    for (const s of screens) {
      const layer =
        (s.freshMeta && s.node.meta ? layerFromMetadata(s.node.meta.text) : null) ?? restLayers.get(s.nodeId) ?? null
      const name = layer?.name || s.node.name || `Frame ${s.nodeId}`
      const safe = safeNodeId(s.nodeId)
      const prev = h.workspaces[workspaceKey]?.screens[`${s.node.fileKey}/${s.nodeId}`]
      const n = prev?.next ?? 1
      const paths = versionPaths(s.node.fileKey, safe, n)
      await mkdir(abs(paths.dir), { recursive: true })
      let png: string | null = null
      if (s.freshShot && s.node.shot) {
        const ext = s.node.shot.path.split('.').pop() ?? 'png'
        png = paths.png.replace(/\.png$/, `.${ext}`)
        await rename(abs(s.node.shot.path), abs(png))
      } else if (restImages.has(s.nodeId)) {
        const bytes = restImages.get(s.nodeId) as Uint8Array
        const ext = imageExt(bytes)
        if (ext) {
          png = paths.png.replace(/\.png$/, `.${ext}`)
          await writeFile(abs(png), bytes)
        }
      }
      let json: string | null = null
      if (layer) {
        json = paths.json
        await writeFile(abs(json), JSON.stringify(layer))
      }
      const { evicted } = addVersion(
        h,
        workspaceKey,
        { fileKey: s.node.fileKey, nodeId: s.nodeId, name },
        { at: config.now(), png, json, task: run.task, terminalId: run.terminalId }
      )
      for (const v of evicted) {
        for (const p of [v.png, v.json]) if (p) await unlink(abs(p)).catch(() => undefined)
      }
      saved.push(`${s.node.fileKey}/${s.nodeId}`)
    }
    const ws = h.workspaces[workspaceKey]
    if (ws) ws.latestRun = saved
    await orca.storage.set(HISTORY, h as never)
    await writeMarkdown(h, run.workspaceId)
  })
  // Stale screenshots (taken before the last write) were not used.
  await Promise.all(pendingFiles.map((p) => rm(abs(p), { force: true })))
  orca.panels.post('history_updated', { workspaceId: run.workspaceId })
}

async function workspacePath(workspaceId: string | null): Promise<string | null> {
  if (!workspaceId) return null
  try {
    const { workspaces } = await orca.host.call('workspace.list')
    return workspaces.find((w) => w.id === workspaceId)?.path ?? null
  } catch {
    return null
  }
}

async function writeMarkdown(h: History, workspaceId: string | null): Promise<void> {
  const ws = h.workspaces[workspaceId ?? NO_WORKSPACE]
  const dir = await workspacePath(workspaceId)
  if (!ws || !dir) return
  try {
    await writeFile(join(dir, HISTORY_FILE), historyMarkdown(ws, config.root))
  } catch (err) {
    orca.log(`could not write ${HISTORY_FILE}: ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Answering the panel

async function resolveWorkspace(h: History, hint: WorkspaceHint): Promise<string | null> {
  const known = Object.keys(h.workspaces)
  if (hint) {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      const match =
        workspaces.find((w) => w.name === hint.displayName && w.branch === hint.branch) ??
        workspaces.find((w) => w.branch === hint.branch && known.includes(w.id)) ??
        workspaces.find((w) => w.name === hint.displayName)
      if (match) return match.id
    } catch {
      // fall through
    }
  }
  const real = known.filter((k) => k !== NO_WORKSPACE)
  return real.length === 1 ? (real[0] as string) : null
}

async function agentStates(): Promise<Map<string, string>> {
  try {
    const { agents } = await orca.host.call('agents.list')
    return new Map(agents.flatMap((a) => (a.terminalId ? [[a.terminalId, a.state] as const] : [])))
  } catch {
    return new Map()
  }
}

function screenOf(h: History, workspaceId: string | null, key: string): StoredScreen | null {
  return h.workspaces[workspaceId ?? NO_WORKSPACE]?.screens[key] ?? h.workspaces[NO_WORKSPACE]?.screens[key] ?? null
}

async function historyView(hint: WorkspaceHint): Promise<HistoryView> {
  const h = await loadHistory()
  const workspaceId = await resolveWorkspace(h, hint)
  const ws = h.workspaces[workspaceId ?? NO_WORKSPACE] ?? h.workspaces[NO_WORKSPACE]
  const screens: ScreenView[] = Object.entries(ws?.screens ?? {})
    .map(([key, s]) => ({
      key,
      name: s.name,
      fileKey: s.fileKey,
      nodeId: s.nodeId,
      versions: s.versions.map((v) => ({ n: v.n, at: v.at, png: v.png, hasStructure: !!v.json, task: v.task }))
    }))
    .sort((a, b) => (b.versions.at(-1)?.at ?? 0) - (a.versions.at(-1)?.at ?? 0))
  const states = await agentStates()
  const newest = Object.values(ws?.screens ?? {})
    .flatMap((s) => s.versions)
    .sort((a, b) => b.at - a.at)[0]
  const state = newest?.terminalId ? states.get(newest.terminalId) : undefined
  return {
    workspaceId,
    screens,
    latestRun: ws?.latestRun ?? [],
    lastError: ((await orca.storage.get(LAST_ERROR)) as HistoryView['lastError']) ?? null,
    agentBusy: state === 'working' || state === 'blocked',
    hasToken: !!(await figmaToken())
  }
}

async function readLayer(rel: string | null): Promise<Layer | null> {
  if (!rel) return null
  try {
    return JSON.parse(await readFile(abs(rel), 'utf8')) as Layer
  } catch {
    return null
  }
}

async function diffOf(screen: StoredScreen, before: number, after: number) {
  const a = screen.versions.find((v) => v.n === before)
  const b = screen.versions.find((v) => v.n === after)
  const [la, lb] = await Promise.all([readLayer(a?.json ?? null), readLayer(b?.json ?? null)])
  return { a, b, result: la && lb ? diffLayers(la, lb) : null }
}

/** The idle agent terminal to talk to: the one that made the screen's newest version, else any. */
async function idleTerminal(screen: StoredScreen): Promise<{ id: string } | { reason: string }> {
  const states = await agentStates()
  const own = screen.versions.at(-1)?.terminalId
  if (own && states.has(own)) {
    return IDLE.has(states.get(own) as string)
      ? { id: own }
      : { reason: 'The agent is still working. Try again when it finishes.' }
  }
  for (const [id, state] of states) if (IDLE.has(state)) return { id }
  return { reason: 'No idle agent found in this workspace.' }
}

async function send(terminalId: string, text: string): Promise<boolean> {
  const { accepted } = await orca.host.call('terminal.sendText', { terminalId, text, enter: true })
  return accepted
}

// ---------------------------------------------------------------------------------------------

/** On start: forget versions whose files are gone, and clear old pending screenshots. */
async function tidy(): Promise<void> {
  await locked(async () => {
    const h = await loadHistory()
    let changed = false
    for (const ws of Object.values(h.workspaces)) {
      for (const [key, s] of Object.entries(ws.screens)) {
        const keep = []
        for (const v of s.versions) {
          if (v.png && !(await exists(v.png))) {
            changed = true
            continue
          }
          keep.push(v)
        }
        s.versions = keep
        if (!keep.length) {
          delete ws.screens[key]
          changed = true
        }
      }
    }
    if (changed) await orca.storage.set(HISTORY, h as never)
  })
  try {
    const dir = abs('captures/_pending')
    const day = 24 * 60 * 60 * 1000
    for (const f of await readdir(dir)) {
      const s = await stat(join(dir, f))
      if (config.now() - s.mtimeMs > day) await rm(join(dir, f), { force: true })
    }
  } catch {
    // no pending folder yet
  }
}

export default function activate(api: OrcaWorkerApi): void {
  orca = api

  orca.hooks.on('agent.tool.after', (e, next) => {
    track(onToolCall(e).catch((err) => orca.log(`tool hook: ${String(err)}`)))
    return next(e)
  })
  orca.hooks.on('agent.prompt.before', (e, next) => {
    track(onPrompt(e).catch((err) => orca.log(`prompt hook: ${String(err)}`)))
    return next(e)
  })
  orca.events.on('agent.status.changed', (e) => {
    const p = onStatus(e).catch((err) => orca.log(`status: ${String(err)}`))
    track(p)
    return p
  })

  orca.panels.handle('history.get', ({ hint }) => historyView(hint))

  orca.panels.handle('diff.get', async ({ workspaceId, screenKey, before, after }): Promise<DiffView> => {
    const screen = screenOf(await loadHistory(), workspaceId, screenKey)
    if (!screen) return { summary: null, items: [] }
    const { result } = await diffOf(screen, before, after)
    return result ? { summary: summarize(result), items: result.items.slice(0, 50) } : { summary: null, items: [] }
  })

  orca.panels.handle('agent.restore', async ({ workspaceId, screenKey, version }) => {
    const screen = screenOf(await loadHistory(), workspaceId, screenKey)
    const v = screen?.versions.find((x) => x.n === version)
    if (!screen || !v) return { sent: false, reason: 'That version no longer exists.' }
    const target = await idleTerminal(screen)
    if ('reason' in target) return { sent: false, reason: target.reason }
    const refs = [
      v.png ? `Reference image (how it should look): ${abs(v.png)}.` : '',
      v.json ? `Layer structure: ${abs(v.json)}.` : ''
    ].join(' ')
    const text =
      `Please restore the Figma screen "${screen.name}" (file ${screen.fileKey}, node ${screen.nodeId}) ` +
      `to how it looked in version v${v.n}. ${refs} Rebuild it to match exactly, keep everything else in the file ` +
      `unchanged, then call get_screenshot on node ${screen.nodeId} so the new version is saved.`
    return (await send(target.id, text.replace(/\s+/g, ' ').trim()))
      ? { sent: true }
      : { sent: false, reason: 'Orca did not accept the message.' }
  })

  orca.panels.handle('agent.explain', async ({ workspaceId, screenKey, before, after }) => {
    const screen = screenOf(await loadHistory(), workspaceId, screenKey)
    if (!screen) return { sent: false, reason: 'That screen no longer exists.' }
    const { a, b, result } = await diffOf(screen, before, after)
    if (!a || !b) return { sent: false, reason: 'That version no longer exists.' }
    const target = await idleTerminal(screen)
    if ('reason' in target) return { sent: false, reason: target.reason }
    const dir = versionPaths(screen.fileKey, safeNodeId(screen.nodeId), b.n).dir
    const diffPath = `${dir}/diff-v${a.n}-v${b.n}.json`
    await mkdir(abs(dir), { recursive: true })
    await writeFile(abs(diffPath), JSON.stringify(result ?? { note: 'Structure not captured for one of the versions.' }, null, 2))
    const text =
      `Please explain, in plain language for a designer, what changed in the Figma screen "${screen.name}" ` +
      `between v${a.n} and v${b.n} and why it improves the design. ` +
      `${a.png ? `Before image: ${abs(a.png)}. ` : ''}${b.png ? `After image: ${abs(b.png)}. ` : ''}` +
      `Change list: ${abs(diffPath)}. Do not change anything in Figma.`
    return (await send(target.id, text.replace(/\s+/g, ' ').trim()))
      ? { sent: true }
      : { sent: false, reason: 'Orca did not accept the message.' }
  })

  orca.panels.handle('error.dismiss', async () => {
    await orca.storage.delete(LAST_ERROR)
    return null
  })

  orca.panels.handle('token.set', async ({ token }) => {
    const t = token.trim()
    if (!t) {
      await orca.secrets.delete(TOKEN)
      return { ok: true }
    }
    await orca.secrets.set(TOKEN, t)
    return { ok: true }
  })

  track(tidy().catch((err) => orca.log(`tidy: ${String(err)}`)))
}
