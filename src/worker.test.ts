// Runs src/worker.ts over a mock Orca host, with captures written to a temp folder and Figma's
// screenshot downloads faked.
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { config, settled } from './worker'
import { MAX_VERSIONS } from './history'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const SHOT_URL = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/shot.png'
const META = (y: number) =>
  `<frame id="10:2" name="Login" x="0" y="0" width="320" height="600"><frame id="10:4" name="Button" x="20" y="${y}" width="280" height="40" /></frame>`

let clock = 1_800_000_000_000
async function setup() {
  config.root = await mkdtemp(join(tmpdir(), 'before-after-'))
  config.env = {}
  config.now = () => (clock += 1000)
  config.fetch = async (url: string) => {
    if (url === SHOT_URL) return new Response(PNG, { status: 200 })
    return new Response('nope', { status: 404 })
  }
  const host = mockHost({
    results: {
      'workspace.list': { workspaces: [{ id: 'ws1', kind: 'worktree', name: 'design', path: config.root, branch: 'main', hostId: null }], truncated: false },
      'agents.list': { agents: [{ terminalId: 't1', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 0 }] },
      'terminal.sendText': { accepted: true }
    }
  })
  const worker = await mountWorker(main, { host })
  return { host, worker }
}

async function agentRun(worker: Awaited<ReturnType<typeof setup>>['worker'], y: number, { screenshotFirst = false } = {}) {
  const base = { agent: 'claude', workspaceId: 'ws1', terminalId: 't1' }
  await worker.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'p1', terminalId: 't1', title: 'Make the button stand out', state: 'working', receivedAt: clock })
  const shot = () =>
    worker.hooks.fire('agent.tool.after', { ...base, tool: 'mcp__figma__get_screenshot', input: { fileKey: 'FILEKEY', nodeId: '10:2' }, output: [{ type: 'text', text: `URL: ${SHOT_URL}` }] })
  if (screenshotFirst) await shot()
  await worker.hooks.fire('agent.tool.after', { ...base, tool: 'mcp__figma__use_figma', input: { fileKey: 'FILEKEY', code: 'figma.getNodeByIdAsync("10:4")' }, output: 'ok' })
  if (!screenshotFirst) {
    await shot()
    await worker.hooks.fire('agent.tool.after', { ...base, tool: 'mcp__figma__get_metadata', input: { fileKey: 'FILEKEY', nodeId: '10:2' }, output: [{ type: 'text', text: META(y) }] })
  }
  await settled()
  await worker.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'p1', terminalId: 't1', title: 'Make the button stand out', state: 'done', receivedAt: clock })
  await settled()
}

test('saves a version when a run changes Figma and screenshots the screen', async () => {
  const { worker } = await setup()
  await agentRun(worker, 300)
  await agentRun(worker, 262)

  const h = await worker.request('history.get', { hint: { branch: 'main', displayName: 'design' } })
  assert.equal(h.workspaceId, 'ws1')
  assert.equal(h.screens.length, 1)
  const s = h.screens[0]!
  assert.equal(s.name, 'Login')
  assert.deepEqual(s.versions.map((v) => v.n), [1, 2])
  assert.equal(s.versions[1]!.task, 'Make the button stand out')
  assert.equal(s.versions[1]!.png, 'captures/FILEKEY/10-2/v2.png')
  assert.deepEqual(h.latestRun, ['FILEKEY/10:2'])
  assert.ok((await stat(join(config.root, 'captures/FILEKEY/10-2/v2.png'))).isFile())

  const d = await worker.request('diff.get', { workspaceId: 'ws1', screenKey: 'FILEKEY/10:2', before: 1, after: 2 })
  assert.equal(d.summary, '1 layer moved')

  const md = await readFile(join(config.root, '.orca-figma-history.md'), 'utf8')
  assert.match(md, /\| Login \(10:2\) \| v2 \|/)

  assert.deepEqual(worker.posts.map((p) => p.event), ['history_updated', 'history_updated'])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('ignores a screenshot taken before the change and saves the version without an image', async () => {
  const { worker } = await setup()
  await agentRun(worker, 300, { screenshotFirst: true })
  const h = await worker.request('history.get', { hint: null })
  assert.equal(h.screens.length, 1)
  assert.equal(h.screens[0]!.versions[0]!.png, null)
  await worker.deactivate()
})

test('a run that only reads Figma saves nothing', async () => {
  const { worker } = await setup()
  const base = { agent: 'claude', workspaceId: 'ws1', terminalId: 't1' }
  await worker.hooks.fire('agent.tool.after', { ...base, tool: 'mcp__figma__get_screenshot', input: { fileKey: 'FILEKEY', nodeId: '10:2' }, output: SHOT_URL })
  await settled()
  await worker.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'p1', terminalId: 't1', state: 'done', receivedAt: clock })
  await settled()
  const h = await worker.request('history.get', { hint: null })
  assert.equal(h.screens.length, 0)
  assert.equal(h.lastError, null)
  await worker.deactivate()
})

test('a change with no screenshot is reported', async () => {
  const { worker } = await setup()
  const base = { agent: 'claude', workspaceId: 'ws1', terminalId: 't1' }
  await worker.hooks.fire('agent.tool.after', { ...base, tool: 'mcp__figma__use_figma', input: { fileKey: 'FILEKEY', code: '' }, output: 'ok' })
  await settled()
  await worker.emit('agent.status.changed', { workspaceId: 'ws1', paneKey: 'p1', terminalId: 't1', state: 'done', receivedAt: clock })
  await settled()
  const h = await worker.request('history.get', { hint: null })
  assert.match(h.lastError?.message ?? '', /took no screenshots/)
  await worker.request('error.dismiss')
  assert.equal((await worker.request('history.get', { hint: null })).lastError, null)
  await worker.deactivate()
})

test(`keeps only the last ${MAX_VERSIONS} versions`, async () => {
  const { worker } = await setup()
  for (let i = 0; i < MAX_VERSIONS + 2; i++) await agentRun(worker, 100 + i)
  const h = await worker.request('history.get', { hint: null })
  const vs = h.screens[0]!.versions
  assert.equal(vs.length, MAX_VERSIONS)
  assert.equal(vs[0]!.n, 3)
  await assert.rejects(() => stat(join(config.root, 'captures/FILEKEY/10-2/v1.png')))
  await worker.deactivate()
})

test('restore and explain type into the idle agent terminal', async () => {
  const { worker, host } = await setup()
  await agentRun(worker, 300)
  await agentRun(worker, 262)
  const r = await worker.request('agent.restore', { workspaceId: 'ws1', screenKey: 'FILEKEY/10:2', version: 1 })
  assert.deepEqual(r, { sent: true })
  const e = await worker.request('agent.explain', { workspaceId: 'ws1', screenKey: 'FILEKEY/10:2', before: 1, after: 2 })
  assert.deepEqual(e, { sent: true })
  const sent = host.callsOf('terminal.sendText') as { terminalId: string; text: string }[]
  assert.equal(sent.length, 2)
  assert.equal(sent[0]!.terminalId, 't1')
  assert.match(sent[0]!.text, /restore the Figma screen "Login".*v1\.png/)
  assert.match(sent[1]!.text, /diff-v1-v2\.json/)
  await worker.deactivate()
})
