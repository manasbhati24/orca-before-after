// Reads an agent's Figma MCP tool calls: which tool, which file and nodes, and any screenshot or
// structure the call returned. Pure functions, so they test without Orca.

/** Figma MCP tools that change a file. */
const WRITE_TOOLS = new Set([
  'use_figma',
  'generate_figma_design',
  'send_code_to_figma',
  'html_to_figma'
])

export type FigmaCallKind = 'write' | 'screenshot' | 'metadata' | 'other'

export type ImageRef = { url: string } | { base64: string }

export type FigmaCall = {
  kind: FigmaCallKind
  tool: string
  fileKey: string | null
  /** Node IDs named in the input (and, for writes, the output), as "12:34". */
  nodeIds: string[]
  /** For screenshot calls: the image the tool returned. */
  image: ImageRef | null
  /** For metadata calls: the XML-like outline the tool returned. */
  metadata: string | null
}

/**
 * The short tool name when `tool` is a Figma MCP tool, else null. Claude Code names MCP tools
 * `mcp__<server>__<tool>`; the server may be `figma`, `claude_ai_Figma`, `plugin_figma_figma`...
 */
export function figmaToolName(tool: string): string | null {
  const parts = tool.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return null
  const server = parts.slice(1, -1).join('__')
  if (!/figma/i.test(server)) return null
  return parts[parts.length - 1] ?? null
}

/** Accepts "12:34", "12-34" and "I12:34;5:6" style ids; answers "12:34" form or null. */
export function normalizeNodeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d+)[:-](\d+)$/.exec(raw.trim())
  return m ? `${m[1]}:${m[2]}` : null
}

/** Every string inside a JSON value, with JSON-looking strings parsed and walked too. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out
  if (typeof value === 'string') {
    out.push(value)
    const t = value.trim()
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 2_000_000) {
      try {
        collectStrings(JSON.parse(t), out, depth + 1)
      } catch {
        // not JSON
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1)
  }
  return out
}

/** Inline images in MCP content blocks: `{ type: 'image', data, mimeType }`. */
function findInlineImage(value: unknown, depth = 0): string | null {
  if (depth > 12 || !value || typeof value !== 'object') {
    if (typeof value === 'string' && depth < 12) {
      const t = value.trim()
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return findInlineImage(JSON.parse(t), depth + 1)
        } catch {
          return null
        }
      }
    }
    return null
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findInlineImage(v, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const o = value as Record<string, unknown>
  if (o.type === 'image') {
    const data = typeof o.data === 'string' ? o.data : (o.source as { data?: unknown } | undefined)?.data
    if (typeof data === 'string' && data.length > 100) return data
  }
  for (const v of Object.values(o)) {
    const hit = findInlineImage(v, depth + 1)
    if (hit) return hit
  }
  return null
}

const URL_RE = /https:\/\/[^\s"'<>)\]]+/g

/** The first image download URL in a tool result. */
export function findImageUrl(output: unknown): string | null {
  for (const s of collectStrings(output)) {
    for (const url of s.match(URL_RE) ?? []) {
      if (/figma\.com\/design|figma\.com\/file/.test(url)) continue
      if (/\.png(\?|$)|amazonaws|cloudfront|figma-alpha|figmausercontent|\/images?\//i.test(url)) {
        return url
      }
    }
  }
  return null
}

const NODE_IN_CODE_RE = /getNodeByIdAsync\(\s*["'`](\d+[:-]\d+)["'`]\s*\)/g
const NODE_ID_KEY_RE = /"(?:id|nodeId|node_id)"\s*:\s*"(\d+:\d+)"/g
const ID_LIST_RE = /"(?:createdNodeIds|mutatedNodeIds|nodeIds|ids)"\s*:\s*\[([^\]]*)\]/g

function nodeIdsFromWrite(input: Record<string, unknown>, output: unknown): string[] {
  const ids = new Set<string>()
  const code = typeof input.code === 'string' ? input.code : ''
  for (const m of code.matchAll(NODE_IN_CODE_RE)) {
    const id = normalizeNodeId(m[1])
    if (id) ids.add(id)
  }
  const direct = normalizeNodeId(input.nodeId)
  if (direct) ids.add(direct)
  for (const s of collectStrings(output)) {
    for (const m of s.matchAll(NODE_ID_KEY_RE)) ids.add(m[1] as string)
    for (const m of s.matchAll(ID_LIST_RE)) {
      for (const q of (m[1] ?? '').matchAll(/"(\d+:\d+)"/g)) ids.add(q[1] as string)
    }
  }
  return [...ids]
}

/** Reads one `agent.tool.after` event; null when it is not a Figma MCP call. */
export function parseFigmaCall(tool: string, input: unknown, output: unknown): FigmaCall | null {
  const name = figmaToolName(tool)
  if (!name) return null
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const fileKey = typeof inp.fileKey === 'string' ? inp.fileKey : null
  const base: FigmaCall = {
    kind: 'other',
    tool: name,
    fileKey,
    nodeIds: [],
    image: null,
    metadata: null
  }
  if (WRITE_TOOLS.has(name)) {
    return { ...base, kind: 'write', nodeIds: nodeIdsFromWrite(inp, output) }
  }
  const nodeId = normalizeNodeId(inp.nodeId)
  if (name === 'get_screenshot') {
    const base64 = findInlineImage(output)
    const url = base64 ? null : findImageUrl(output)
    const image: ImageRef | null = base64 ? { base64 } : url ? { url } : null
    return { ...base, kind: 'screenshot', nodeIds: nodeId ? [nodeId] : [], image }
  }
  if (name === 'get_metadata') {
    const text = collectStrings(output).find((s) => /<\w+[^>]*\bid="\d+:\d+"/.test(s)) ?? null
    return { ...base, kind: 'metadata', nodeIds: nodeId ? [nodeId] : [], metadata: text }
  }
  return { ...base, nodeIds: nodeId ? [nodeId] : [] }
}

/** File-system-safe form of a node id: "12:34" -> "12-34". */
export function safeNodeId(nodeId: string): string {
  return nodeId.replace(/[^0-9A-Za-z]+/g, '-')
}
