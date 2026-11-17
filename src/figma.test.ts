import { assert, test } from 'orca/testing'
import { figmaToolName, findImageUrl, normalizeNodeId, parseFigmaCall } from './figma'
import { diffLayers, layerFromMetadata, layerFromRest, summarize } from './diff'

test('recognises Figma MCP tools from any server name', () => {
  assert.equal(figmaToolName('mcp__figma__use_figma'), 'use_figma')
  assert.equal(figmaToolName('mcp__claude_ai_Figma__get_screenshot'), 'get_screenshot')
  assert.equal(figmaToolName('mcp__plugin_figma_figma__get_metadata'), 'get_metadata')
  assert.equal(figmaToolName('mcp__github__get_file'), null)
  assert.equal(figmaToolName('Bash'), null)
})

test('normalizes node ids', () => {
  assert.equal(normalizeNodeId('12-34'), '12:34')
  assert.equal(normalizeNodeId('12:34'), '12:34')
  assert.equal(normalizeNodeId('page'), null)
})

test('reads a write call and the node ids it touched', () => {
  const call = parseFigmaCall(
    'mcp__figma__use_figma',
    { fileKey: 'ABC', code: 'const f = await figma.getNodeByIdAsync("10:2"); f.name = "x"' },
    [{ type: 'text', text: '{"createdNodeIds":["11:1","11:2"]}' }]
  )
  assert.equal(call?.kind, 'write')
  assert.deepEqual(call?.nodeIds.sort(), ['10:2', '11:1', '11:2'])
})

test('reads a screenshot URL and node', () => {
  const output = [{ type: 'text', text: 'Screenshot ready: https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc.png\ncurl -o x.png ...' }]
  const call = parseFigmaCall('mcp__figma__get_screenshot', { fileKey: 'ABC', nodeId: '10-2' }, output)
  assert.equal(call?.kind, 'screenshot')
  assert.deepEqual(call?.nodeIds, ['10:2'])
  assert.deepEqual(call?.image, { url: 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc.png' })
  assert.equal(findImageUrl('see https://www.figma.com/design/ABC/x for the file'), null)
})

test('reads an inline screenshot', () => {
  const data = 'iVBORw0KGgo'.padEnd(200, 'A')
  const call = parseFigmaCall('mcp__figma__get_screenshot', { fileKey: 'ABC', nodeId: '1:2' }, [{ type: 'image', data, mimeType: 'image/png' }])
  assert.deepEqual(call?.image, { base64: data })
})

const META_BEFORE = `<frame id="10:2" name="Login" x="400" y="0" width="320" height="600">
  <text id="10:3" name="Heading" x="20" y="20" width="200" height="24" />
  <frame id="10:4" name="Button" x="20" y="300" width="280" height="40">
    <text id="10:5" name="Label" x="100" y="10" width="80" height="20" />
  </frame>
</frame>`
const META_AFTER = `<frame id="10:2" name="Login" x="900" y="0" width="320" height="600">
  <text id="10:3" name="Heading" x="20" y="20" width="240" height="24" />
  <frame id="12:9" name="Button" x="20" y="262" width="280" height="40">
    <text id="12:10" name="Label" x="100" y="10" width="80" height="20" />
  </frame>
  <text id="12:11" name="Forgot" x="20" y="320" width="100" height="16" />
</frame>`

test('diffs two metadata outlines, matching rebuilt layers by name', () => {
  const a = layerFromMetadata(META_BEFORE)
  const b = layerFromMetadata(META_AFTER)
  assert.equal(a?.name, 'Login')
  assert.equal(a?.children.length, 2)
  const d = diffLayers(a!, b!)
  assert.equal(d.moved, 1)
  assert.equal(d.resized, 1)
  assert.equal(d.added, 1)
  assert.equal(d.removed, 0)
  assert.equal(summarize(d), '1 layer moved · 1 layer resized · 1 layer added')
  assert.ok(d.items.some((i) => i.name === 'Button' && i.detail === 'Moved 38 px up'))
})

test('diffs REST structures, including text and colour', () => {
  const node = (chars: string, color: { r: number; g: number; b: number }) => ({
    id: '1:1',
    name: 'Screen',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    children: [
      { id: '1:2', name: 'Title', type: 'TEXT', characters: chars, absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 10 } },
      { id: '1:3', name: 'CTA', type: 'RECTANGLE', fills: [{ type: 'SOLID', color }], absoluteBoundingBox: { x: 0, y: 50, width: 50, height: 10 } }
    ]
  })
  const d = diffLayers(layerFromRest(node('Welcome back', { r: 0.8, g: 0.8, b: 0.8 })), layerFromRest(node('Sign in', { r: 0, g: 0.4, b: 1 })))
  assert.equal(summarize(d), '1 text layer changed · 1 colour changed')
  assert.ok(d.items.some((i) => i.detail === 'Text: “Welcome back” → “Sign in”'))
})
