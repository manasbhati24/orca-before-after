// Draws the panel against stand-ins for the worker's answers.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { HistoryView } from './protocol'

const base: HistoryView = { workspaceId: 'ws1', screens: [], latestRun: [], lastError: null, agentBusy: false, hasToken: false }
const withVersions = (agentBusy = false): HistoryView => ({
  ...base,
  agentBusy,
  latestRun: ['F/10:2'],
  screens: [
    {
      key: 'F/10:2',
      name: 'Login',
      fileKey: 'F',
      nodeId: '10:2',
      versions: [
        { n: 3, at: 1_800_000_000_000, png: 'assets/sample-before.png', hasStructure: true, task: null },
        { n: 4, at: 1_800_000_600_000, png: 'assets/sample-after.png', hasStructure: true, task: 'Make the button stand out' }
      ]
    }
  ]
})

function hostWith(h: HistoryView, sent: { restore: unknown[] } = { restore: [] }) {
  return mockHost({
    requests: {
      'history.get': () => h,
      'diff.get': () => ({ summary: '1 layer moved', items: [{ name: 'Button', detail: 'Moved 38 px up' }] }),
      'agent.restore': (input) => {
        sent.restore.push(input)
        return { sent: true }
      }
    },
    results: { 'workspace.readContext': { branch: 'main', displayName: 'design', terminals: [] } }
  })
}

test('listens until there is history', async () => {
  const view = await mount(panel, { host: hostWith(base) })
  assert.ok(view.find({ text: /Ready and listening/ }))
  assert.ok(view.find({ text: panel.CAPTURE_LINE }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('blinks between before and after and restores the before version', async () => {
  const sent = { restore: [] as unknown[] }
  const view = await mount(panel, { host: hostWith(withVersions(), sent) })
  assert.equal(view.find({ type: 'Image' })?.props.src, 'assets/sample-after.png')
  assert.ok(view.find({ text: 'Showing After · v4' }))
  assert.ok(view.find({ text: '1 layer moved' }))
  assert.ok(view.find({ text: 'Task: Make the button stand out' }))

  await view.press({ type: 'Button', text: 'Before' })
  assert.equal(view.find({ type: 'Image' })?.props.src, 'assets/sample-before.png')

  await view.press({ text: 'Restore Before (v3)' })
  assert.deepEqual(sent.restore, [{ workspaceId: 'ws1', screenKey: 'F/10:2', version: 3 }])
  assert.ok(view.find({ text: /Asked the agent to restore v3/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('disables agent actions while the agent works', async () => {
  const view = await mount(panel, { host: hostWith(withVersions(true)) })
  assert.equal(view.find({ text: 'Restore Before (v3)' })?.disabled, true)
  assert.equal(view.find({ text: 'Ask agent to explain' })?.disabled, true)
  await view.unmount()
})

test('shows a saved error', async () => {
  const view = await mount(panel, { host: hostWith({ ...base, lastError: { message: 'Figma’s usage limit was reached.', at: 1 } }) })
  assert.ok(view.find({ text: /usage limit/ }))
  assert.ok(view.summary().some((line) => /Something went wrong/.test(line)))
  await view.unmount()
})
