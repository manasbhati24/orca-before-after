// A screen's structure in one small shape, read from Figma's REST JSON or the MCP's get_metadata
// outline, and a deterministic comparison of two of them. No LLM involved.

export type Layer = {
  id: string
  name: string
  type: string
  x: number
  y: number
  w: number
  h: number
  /** Text content, for text layers when known. */
  text?: string
  /** First solid fill as #rrggbb, when known. */
  fill?: string
  children: Layer[]
}

const round = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0)

function toHex(c: { r?: number; g?: number; b?: number } | undefined): string | undefined {
  if (!c) return undefined
  const h = (v: number | undefined) =>
    Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

type RestNode = {
  id?: string
  name?: string
  type?: string
  characters?: string
  absoluteBoundingBox?: { x?: number; y?: number; width?: number; height?: number } | null
  fills?: { type?: string; visible?: boolean; color?: { r: number; g: number; b: number } }[]
  children?: RestNode[]
}

/** From `GET /v1/files/:key/nodes` → `nodes[id].document`. Positions are relative to the root. */
export function layerFromRest(doc: RestNode, origin?: { x: number; y: number }): Layer {
  const box = doc.absoluteBoundingBox ?? {}
  const o = origin ?? { x: round(box.x), y: round(box.y) }
  const fill = doc.fills?.find((f) => f.type === 'SOLID' && f.visible !== false)
  return {
    id: doc.id ?? '',
    name: doc.name ?? '',
    type: doc.type ?? '',
    x: round(box.x) - o.x,
    y: round(box.y) - o.y,
    w: round(box.width),
    h: round(box.height),
    ...(typeof doc.characters === 'string' ? { text: doc.characters } : {}),
    ...(fill ? { fill: toHex(fill.color) } : {}),
    children: (doc.children ?? []).map((c) => layerFromRest(c, o))
  }
}

/** From the MCP's get_metadata outline: nested tags like `<frame id="1:2" name=".." x=".." ...>`. */
export function layerFromMetadata(xml: string): Layer | null {
  const tagRe = /<(\/?)([\w-]+)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/g
  const attrRe = /([\w-]+)="([^"]*)"/g
  const stack: Layer[] = []
  let root: Layer | null = null
  for (const m of xml.matchAll(tagRe)) {
    const [, closing, tag, attrText, selfClosing] = m
    if (closing) {
      stack.pop()
      continue
    }
    const attrs: Record<string, string> = {}
    for (const a of (attrText ?? '').matchAll(attrRe)) attrs[a[1] as string] = unescapeXml(a[2] as string)
    if (!attrs.id) continue
    const layer: Layer = {
      id: attrs.id,
      name: attrs.name ?? '',
      type: (tag ?? '').toUpperCase(),
      x: round(Number(attrs.x)),
      y: round(Number(attrs.y)),
      w: round(Number(attrs.width)),
      h: round(Number(attrs.height)),
      children: []
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(layer)
    else if (!root) root = layer
    if (!selfClosing) stack.push(layer)
  }
  return root
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

type Flat = { layer: Layer; path: string }

function flatten(root: Layer): Flat[] {
  const out: Flat[] = []
  const walk = (l: Layer, parentPath: string) => {
    const path = parentPath ? `${parentPath}/${l.name}` : l.name
    out.push({ layer: l, path })
    for (const c of l.children) walk(c, path)
  }
  // The root is the screen itself; its own position on the canvas is not a change.
  for (const c of root.children) walk(c, '')
  return out
}

export type DiffItem = { name: string; detail: string }
export type DiffResult = {
  textChanged: number
  colorChanged: number
  moved: number
  resized: number
  renamed: number
  added: number
  removed: number
  items: DiffItem[]
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Compares two versions of one screen. Layers match by id, then by name path (agents often
 *  rebuild a layer, which gives it a new id). */
export function diffLayers(before: Layer, after: Layer): DiffResult {
  const a = flatten(before)
  const b = flatten(after)
  const r: DiffResult = { textChanged: 0, colorChanged: 0, moved: 0, resized: 0, renamed: 0, added: 0, removed: 0, items: [] }
  const byId = new Map(a.map((f) => [f.layer.id, f]))
  const byPath = new Map<string, Flat[]>()
  for (const f of a) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f])
  const used = new Set<Flat>()
  const unmatched: Flat[] = []
  const pairs: [Flat, Flat][] = []
  for (const f of b) {
    const hit = byId.get(f.layer.id)
    if (hit && !used.has(hit)) {
      used.add(hit)
      pairs.push([hit, f])
    } else unmatched.push(f)
  }
  for (const f of unmatched) {
    const hit = (byPath.get(f.path) ?? []).find((c) => !used.has(c))
    if (hit) {
      used.add(hit)
      pairs.push([hit, f])
    } else {
      r.added++
      r.items.push({ name: f.layer.name || f.layer.type, detail: 'Added' })
    }
  }
  for (const f of a) {
    if (!used.has(f)) {
      r.removed++
      r.items.push({ name: f.layer.name || f.layer.type, detail: 'Removed' })
    }
  }
  for (const [x, y] of pairs) {
    const name = y.layer.name || y.layer.type
    if (x.layer.text !== undefined && y.layer.text !== undefined && x.layer.text !== y.layer.text) {
      r.textChanged++
      r.items.push({ name, detail: `Text: “${clip(x.layer.text)}” → “${clip(y.layer.text)}”` })
    }
    if (x.layer.fill && y.layer.fill && x.layer.fill !== y.layer.fill) {
      r.colorChanged++
      r.items.push({ name, detail: `Colour: ${x.layer.fill} → ${y.layer.fill}` })
    }
    const dx = y.layer.x - x.layer.x
    const dy = y.layer.y - x.layer.y
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
      r.moved++
      const parts = []
      if (dy) parts.push(`${Math.abs(dy)} px ${dy < 0 ? 'up' : 'down'}`)
      if (dx) parts.push(`${Math.abs(dx)} px ${dx < 0 ? 'left' : 'right'}`)
      r.items.push({ name, detail: `Moved ${parts.join(', ')}` })
    }
    if (x.layer.w !== y.layer.w || x.layer.h !== y.layer.h) {
      r.resized++
      r.items.push({ name, detail: `Size: ${x.layer.w}×${x.layer.h} → ${y.layer.w}×${y.layer.h}` })
    }
    if (x.layer.name !== y.layer.name && x.layer.id === y.layer.id) {
      r.renamed++
      r.items.push({ name, detail: `Renamed from “${clip(x.layer.name)}”` })
    }
  }
  return r
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "2 text layers changed · 1 colour changed · 1 layer moved", or a no-change sentence. */
export function summarize(d: DiffResult): string {
  const parts: string[] = []
  if (d.textChanged) parts.push(`${plural(d.textChanged, 'text layer')} changed`)
  if (d.colorChanged) parts.push(`${plural(d.colorChanged, 'colour')} changed`)
  if (d.moved) parts.push(`${plural(d.moved, 'layer')} moved`)
  if (d.resized) parts.push(`${plural(d.resized, 'layer')} resized`)
  if (d.renamed) parts.push(`${plural(d.renamed, 'layer')} renamed`)
  if (d.added) parts.push(`${plural(d.added, 'layer')} added`)
  if (d.removed) parts.push(`${plural(d.removed, 'layer')} removed`)
  return parts.length ? parts.join(' · ') : 'No structural changes found.'
}
