// The Before / After side panel. Orca compiles this TSX when the panel loads: no build step.
// It only draws; the worker (src/worker.ts) captures screens and answers every request.
import {
  atom,
  Badge,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Field,
  Grid,
  Heading,
  host,
  IconButton,
  Image,
  Input,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Select,
  set,
  Stack,
  Text,
  type PanelContext
} from 'orca'
import type { DiffView, HistoryView, ScreenView, VersionView, WorkspaceHint } from './protocol'

export const CAPTURE_LINE =
  'After changing a Figma screen, call get_screenshot (and get_metadata) on each top-level frame you changed.'

const history = atom<HistoryView | null>(null)
const hint = atom<WorkspaceHint>(null)
const screenKey = atom<string | null>(null)
const beforeN = atom<number | null>(null)
const afterN = atom<number | null>(null)
const showing = atom<'before' | 'after'>('after')
const diff = atom<DiffView | null>(null)
const notice = atom<{ tone: 'success' | 'warning'; text: string } | null>(null)
const settingsOpen = atom(false)
const tokenDraft = atom('')

// ---------------------------------------------------------------------------------------------

function currentScreen(h: HistoryView | null, key: string | null): ScreenView | null {
  if (!h || !h.screens.length) return null
  return h.screens.find((s) => s.key === key) ?? h.screens.find((s) => s.key === h.latestRun[0]) ?? h.screens[0] ?? null
}

/** The versions being compared, with the defaults: After = newest, Before = the one before it. */
function pair(screen: ScreenView, b: number | null, a: number | null) {
  const vs = screen.versions
  const after = vs.find((v) => v.n === a) ?? vs[vs.length - 1] ?? null
  const idx = after ? vs.indexOf(after) : -1
  const before = vs.find((v) => v.n === b && v !== after) ?? (idx > 0 ? vs[idx - 1] : null) ?? null
  return { before, after }
}

function timeLabel(at: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

// ---------------------------------------------------------------------------------------------

async function refresh(resetSelection = false): Promise<void> {
  try {
    const h = await plugin.request('history.get', { hint: read(hint) })
    set(history, h)
    if (resetSelection || !h.screens.some((s) => s.key === read(screenKey))) {
      set(screenKey, h.latestRun[0] ?? h.screens[0]?.key ?? null)
      set(beforeN, null)
      set(afterN, null)
      set(showing, 'after')
    }
    await loadDiff()
  } catch (err) {
    set(notice, { tone: 'warning', text: `Could not load history: ${err instanceof Error ? err.message : String(err)}` })
  }
}

async function loadDiff(): Promise<void> {
  const h = read(history)
  const screen = currentScreen(h, read(screenKey))
  if (!h || !screen) return set(diff, null)
  const { before, after } = pair(screen, read(beforeN), read(afterN))
  if (!before || !after) return set(diff, null)
  set(diff, await plugin.request('diff.get', { workspaceId: h.workspaceId, screenKey: screen.key, before: before.n, after: after.n }))
}

async function choose(update: () => void): Promise<void> {
  update()
  set(notice, null)
  await loadDiff()
}

async function restore(screen: ScreenView, version: VersionView): Promise<void> {
  const r = await plugin.request('agent.restore', { workspaceId: read(history)?.workspaceId ?? null, screenKey: screen.key, version: version.n })
  set(notice, r.sent
    ? { tone: 'success', text: `Asked the agent to restore v${version.n}. The result will be saved as a new version.` }
    : { tone: 'warning', text: r.reason ?? 'Could not reach the agent.' })
}

async function explain(screen: ScreenView, before: VersionView, after: VersionView): Promise<void> {
  const r = await plugin.request('agent.explain', { workspaceId: read(history)?.workspaceId ?? null, screenKey: screen.key, before: before.n, after: after.n })
  set(notice, r.sent
    ? { tone: 'success', text: 'Asked the agent to explain the changes. See its terminal.' }
    : { tone: 'warning', text: r.reason ?? 'Could not reach the agent.' })
}

async function saveToken(): Promise<void> {
  await plugin.request('token.set', { token: read(tokenDraft) })
  set(tokenDraft, '')
  set(settingsOpen, false)
  await refresh()
}

async function dismissError(): Promise<void> {
  await plugin.request('error.dismiss')
  await refresh()
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('history_updated', () => void refresh(true)),
    plugin.on('capture_error', () => void refresh()),
    on('agent.status.changed', () => void refresh()),
    on('workspace.changed', ({ context }) => {
      set(hint, context ? { branch: context.branch, displayName: context.displayName } : null)
      void refresh(true)
    })
  )
  void host
    .call('workspace.readContext')
    .then((c) => set(hint, c ? { branch: c.branch, displayName: c.displayName } : null))
    .catch(() => undefined)
    .finally(() => void refresh(true))
}

// ---------------------------------------------------------------------------------------------

function Header() {
  return (
    <Row justify="between">
      <Heading>Before / After</Heading>
      <IconButton icon="settings" label="Settings" variant="ghost" onPress={() => set(settingsOpen, !read(settingsOpen))} />
    </Row>
  )
}

function ErrorBox({ h }: { h: HistoryView }) {
  if (!h.lastError) return null
  return (
    <Callout tone="danger" title="Something went wrong" icon="warning">
      <Stack gap="xs">
        <Text size="sm">{h.lastError.message}</Text>
        <Row justify="end">
          <Button variant="ghost" size="sm" onPress={dismissError}>Dismiss</Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function Settings({ h }: { h: HistoryView }) {
  return (
    <Stack gap="sm">
      <EmptyState
        title="Optional: connect Figma directly"
        description="Screens are already saved from the agent’s own Figma screenshots. A token adds a backup, if your Figma plan’s limits allow it."
        icon="plug"
      />
      <Field label="Figma access token" description="Saved in this plugin’s private secrets in Orca. Leave empty and save to remove it.">
        <Input label="Figma access token" labelHidden type="password" placeholder={h.hasToken ? 'A token is saved' : 'figd_…'} value={read(tokenDraft)} onChange={(v) => set(tokenDraft, v)} onSubmit={saveToken} />
      </Field>
      <Stack gap="xs" align="stretch">
        <Button onPress={saveToken}>Save token</Button>
        <Button variant="ghost" onPress={() => set(settingsOpen, false)}>Back</Button>
      </Stack>
    </Stack>
  )
}

function Listening() {
  return (
    <Stack gap="md">
      <EmptyState
        title="No changes yet"
        description="Ready and listening. Ask the agent to make a change in Figma to see your before/after history here."
        icon="layers"
      >
        <Badge>Listening</Badge>
      </EmptyState>
      <Callout title="Tip: capture every change" icon="lightbulb">
        <Stack gap="xs">
          <Text size="sm" muted>Add this line to your agent instructions (for example CLAUDE.md):</Text>
          <CodeView code={CAPTURE_LINE} wrap label="Line to add" />
        </Stack>
      </Callout>
    </Stack>
  )
}

function Compare({ h, screen }: { h: HistoryView; screen: ScreenView }) {
  const { before, after } = pair(screen, read(beforeN), read(afterN))
  const view = read(showing) === 'before' && before ? before : after
  const d = read(diff)
  const n = read(notice)
  const options = [...screen.versions].reverse().map((v, i) => ({
    value: String(v.n),
    label: `v${v.n} · ${i === 0 ? 'Latest' : timeLabel(v.at)}`
  }))
  return (
    <Stack gap="md">
      <Select
        label="Screen"
        value={screen.key}
        options={h.screens.map((s) => ({ value: s.key, label: `${s.name} · ${s.versions.length} ${s.versions.length === 1 ? 'version' : 'versions'}` }))}
        onChange={(v) => choose(() => { set(screenKey, v); set(beforeN, null); set(afterN, null); set(showing, 'after') })}
      />
      <Grid columns={2} gap="sm">
        <Select
          label="Before"
          value={before ? String(before.n) : ''}
          placeholder="None yet"
          disabled={!before}
          options={options.filter((o) => o.value !== String(after?.n))}
          onChange={(v) => choose(() => { set(beforeN, Number(v)); set(showing, 'before') })}
        />
        <Select
          label="After"
          value={after ? String(after.n) : ''}
          options={options}
          onChange={(v) => choose(() => { set(afterN, Number(v)); set(showing, 'after') })}
        />
      </Grid>
      <Grid columns={2} gap="xs">
        <Stack align="stretch">
          <Button variant={view === before && before ? 'solid' : 'outline'} tone={view === before && before ? 'accent' : 'neutral'} disabled={!before} onPress={() => set(showing, 'before')}>Before</Button>
        </Stack>
        <Stack align="stretch">
          <Button variant={view === after ? 'solid' : 'outline'} tone={view === after ? 'accent' : 'neutral'} onPress={() => set(showing, 'after')}>After</Button>
        </Stack>
      </Grid>
      {view ? (
        <Stack gap="xs">
          <Row gap="sm">
            <Badge tone={view === after ? 'accent' : 'neutral'}>{`Showing ${view === after ? 'After' : 'Before'} · v${view.n}`}</Badge>
            <Text size="xs" muted>{timeLabel(view.at)}</Text>
          </Row>
          {view.png ? (
            <Image src={view.png} alt={`${screen.name}, version ${view.n}`} size="full" fit="contain" rounded />
          ) : (
            <Callout tone="neutral" icon="info">No image captured for this version.</Callout>
          )}
        </Stack>
      ) : null}
      <Callout title="What changed" icon="info" tone="accent">
        <Stack gap="xs">
          {after?.task ? <Text size="sm">{`Task: ${after.task}`}</Text> : null}
          <Text size="sm" muted>
            {!before
              ? 'This is the first saved version of this screen.'
              : d?.summary ?? 'Structure not captured for one of these versions, so only the images can be compared.'}
          </Text>
        </Stack>
      </Callout>
      {d && d.items.length ? (
        <Collapsible title={`Changed elements (${d.items.length})`}>
          <List label="Changed elements">
            {d.items.map((item, i) => (
              <ListItem key={`${i}`} title={item.name} description={item.detail} />
            ))}
          </List>
        </Collapsible>
      ) : null}
      {h.agentBusy ? <Text size="xs" muted>Agent is working. These actions unlock when it finishes.</Text> : null}
      {n ? <Callout tone={n.tone}>{n.text}</Callout> : null}
      <Stack gap="xs" align="stretch">
        <Button tone="accent" disabled={!before || h.agentBusy} onPress={() => before && restore(screen, before)}>
          {before ? `Restore Before (v${before.n})` : 'Restore Before'}
        </Button>
        <Button variant="outline" disabled={!before || !after || h.agentBusy} onPress={() => before && after && explain(screen, before, after)}>
          Ask agent to explain
        </Button>
      </Stack>
    </Stack>
  )
}

export default function Panel() {
  const h = read(history)
  const screen = currentScreen(h, read(screenKey))
  return (
    <Stack gap="md">
      <Header />
      {h ? <ErrorBox h={h} /> : null}
      {!h ? (
        <Text muted>Loading…</Text>
      ) : read(settingsOpen) ? (
        <Settings h={h} />
      ) : screen ? (
        <Compare h={h} screen={screen} />
      ) : (
        <Listening />
      )}
    </Stack>
  )
}
