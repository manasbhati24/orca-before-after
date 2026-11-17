# Before/After — Orca Plugin Feature Spec (For Coding Agent)

**Status:** Implemented in `src/` (2026-11-16). Tests pass. Not yet tried live in Orca: the real
Figma MCP output format and showing images saved while the panel is open still need a live check.
**Architecture:** Orca right-sidebar (side panel) plugin for designers. Manifest `execution:
"trusted-worker"`, with `main: "src/worker.ts"` and a components panel `src/panel.tsx`. Scaffold it
with `orca plugin create <dir> --template worker-panel`.
**Primary Goal:** Automatically capture, store and display before/after versions of Figma screens
changed by an Orca agent. The design must work in a 320px-wide sidebar and follow Orca's sandboxed-UI
rules.
**Design file:** https://www.figma.com/design/ArkMZJE1RFQ4b5co53OaT8. The section "v2 · Blink
layout (current spec)" holds panel states 1–6 (frames `19:54`, `19:74`, `19:141`, `19:208`,
`19:291`, `19:368`). The old stacked sketch is kept in a "superseded" section.

---

## 0. Review changes (2026-11-16)

These changes were made after checking the spec against Orca's plugin typings and Figma's API limits.
Sections 1 to 4 already include them.

1. **The Figma REST API cannot be the main way to capture screens.**
   - Both endpoints in the old spec (`/v1/images` and `/v1/files/:key/nodes`) are Tier 1.
   - Figma limits Tier 1 calls very tightly for View or Collab seats and for files in Starter plans.
     Reports range from about 6 requests a month to a few per minute, depending on plan and seat.
     The user's own file is in a Starter team where they have a View seat.
   - Capturing every agent run would hit that limit almost immediately.
   - New approach: **harvest images from the agent's own Figma MCP calls** (section 2.1). The REST
     API becomes an optional fallback for paid plans.
2. **"Zero-touch" token lookup changed.**
   - A plugin can read only its **own** Orca secrets (`secrets:own`).
   - It must not read the token the Figma MCP uses. That is an OAuth sign-in held by the agent app,
     not the plugin's to take.
   - With MCP harvesting, **no token is needed at all**, so setup really is zero-touch.
   - A token (from `process.env.FIGMA_ACCESS_TOKEN` or pasted by the user) only turns on the
     optional REST fallback.
3. **The "exact prompt" is not always available.**
   - Orca's `agent.prompt.before` hook sees only prompts Orca itself submits. It never sees what the
     person types.
   - The Callout shows the prompt when the plugin has it. Otherwise it shows the agent's terminal
     title (`title` in `agent.status.changed`), which is usually a short task summary.
4. **Worker memory is not durable.**
   - Orca can stop or reload the worker between tool calls, and a reload drops in-memory state.
   - The list of touched nodes per run is therefore kept in `orca.storage`, not only in memory.
5. **The source of truth is `orca.storage`, not the Markdown file.**
   - On restart the worker reads the history index from storage, not by parsing Markdown.
   - The Markdown file is a generated copy for the agent to read.
6. **Messages to the agent are sent only when it is idle.**
   - `terminal.sendText` types into the agent's terminal. If the agent is busy, the text gets mixed
     into its current work.
   - "Ask agent" and "Restore" are disabled unless that agent's state is `done` or `waiting`.
   - They send **file paths**, not large JSON blobs.
7. **Toggle labels changed** from "View Left / View Right" to "Before / After", which reads more
   clearly. The dropdowns are labelled "Before" and "After" to match.
8. **One rule for the default screen:** the first screen captured in the most recent run.
9. **Errors are stored, not only posted.**
   - The panel may be closed when an error happens, so the last error is also written to
     `orca.storage`.
   - The panel reads it when it opens.

---

## 1. System Architecture & Constraints

* **Split architecture.**
  * The panel (`src/panel.tsx`) is sandboxed: no network, no file system, no Figma.
  * The trusted worker (`src/worker.ts`, `export default function activate(orca)`) is a full Node
    process. It handles fetching, files and hooks.
  * The panel calls the worker with `plugin.request(name, input)`, answered by
    `orca.panels.handle(name, fn)`. The worker pushes updates with `orca.panels.post(event, payload)`,
    which the panel receives through `plugin.on(event, fn)`.
  * Shared request and event types live in `src/protocol.ts`, declared by extending `PluginRequests`
    and `PluginPanelEvents`.
* **Component library.**
  * The panel uses only Orca's component catalog, such as `Stack`, `Row`, `Box`, `Text`, `Heading`,
    `Button`, `IconButton`, `Badge`, `List`, `ListItem`, `Select`, `Callout`, `Image`, `EmptyState`,
    `Collapsible`, `Spinner` and `Input`.
  * No custom CSS, DOM work or third-party UI.
  * The panel imports only `orca` and relative files.
* **Image rendering.**
  * `<Image src>` takes a path to a file inside the plugin folder, never a URL.
  * Captured PNGs are written to `captures/` inside the plugin folder, with a unique file name per
    version that is never overwritten.
  * Add `captures/` to `.gitignore`.
  * **Verify first:** that `<Image>` shows a file written after the panel loaded.
* **Manifest.** Expected contents (check with `orca plugin validate .`):
  * `contributes.hooks`: `agent.tool.after`
  * `contributes.events`: `agent.status.changed`
  * capabilities: `storage:own`, `secrets:own`, `settings:own`, `agent:read`, `terminal:send`,
    `workspace:read`
  * `engines.orca` at least the newest feature used
* **Setup is zero-touch.**
  * Capture works with no token (section 2.1, path A).
  * The optional REST fallback uses `process.env.FIGMA_ACCESS_TOKEN`, then a token in the plugin's
    own secrets.
  * The plugin never reads another app's credentials.
* **Limits to state in the README.**
  * Only agents running in Orca terminals are observed. SSH and WSL agents are not hooked yet.
  * Edits a person makes by hand in Figma are not captured.

---

## 2. Data Capture & Storage Engine (The Worker)

### 2.1 The capture lifecycle

1. **Listen.**
   * Hook `agent.tool.after`. It is observe-only: return `next(event)` and never block.
   * Watch for Figma MCP tools by name, matching the `figma` server prefix. The two groups are
     written and read tools.
   * **Write tools** (`use_figma`, `generate_figma_design`, `send_code_to_figma`, …) mark the run as
     "changed Figma". Record the file key and any node IDs found in the input or output.
   * **Read tools** (`get_screenshot`, `get_metadata`, `get_design_context`, …) are harvested for
     data (step 3) but do not by themselves count as a change.
2. **Accumulate.**
   * Keep a per-run record in `orca.storage`, keyed by terminal or pane:
     * file key
     * touched node IDs
     * harvested screenshot URLs or inline images
     * harvested structure
     * run start time
     * prompt or title, if known
3. **Capture images.** When `agent.status.changed` reaches `done` for that terminal, and the run
   changed Figma, deduplicate the node IDs and get one PNG per node.
   * **Path A (default, no token).** Use images the agent already produced through its Figma MCP:
     * the short-lived image URL in a `get_screenshot` result, which the worker downloads straight
       away;
     * or an inline image in a `use_figma` result (from `node.screenshot()`).
     * To make this dependable, the plugin's README gives the user one line to add to the project's
       agent instructions (for example `CLAUDE.md`): *"After changing a Figma screen, call
       get_screenshot on each top-level frame you changed."*
   * **Path B (optional fallback, needs a token and a plan whose Figma rate limits allow it).**
     * Call `GET /v1/images/:key?ids=…&format=png`, then download each returned URL.
     * Respect `429` and its `Retry-After` header.
     * Never retry in a loop.
   * A node with no image from either path is still recorded as a version with "No image", so the
     history stays complete.
4. **Capture structure (for the fact diff).**
   * Use what the run already produced: `get_metadata` or `get_design_context` output for those
     nodes. Otherwise Path B `GET /v1/files/:key/nodes` when the fallback is on.
   * Store a trimmed JSON per node: id, name, type, characters, fills, size and position, children.
   * If no structure is available, the fact diff falls back to "Structure not captured for this
     version".
5. **Save and broadcast.**
   * Write `captures/<fileKey>/<nodeId>/v<N>.png` and `.json`.
   * Update the index in `orca.storage`, regenerate the Markdown file (2.2) and enforce the limit
     (2.3).
   * Then call `orca.panels.post('history_updated', { workspaceId, screens })`.

### 2.2 History index for agent context

* **Source of truth:** the key `history` in `orca.storage`. For each workspace it holds screens, and
  each screen holds `{ fileKey, nodeId, name, versions: [{ n, at, png, json, prompt, terminalId }] }`.
* **Agent copy:**
  * The worker regenerates `.orca-figma-history.md` at the workspace root. The path comes from
    `workspace.list`, matched to the run's `workspaceId`.
  * It is a Markdown table with columns: Screen | Version | Time | PNG (absolute path) | JSON
    (absolute path) | Prompt.
  * The file starts with a one-line note telling the agent what it is.
* Suggest adding `.orca-figma-history.md` to the project's `.gitignore`. The plugin must never edit
  `.gitignore` itself.

### 2.3 Garbage collection

* **Limit:** 20 versions per Figma screen.
* **Cleanup:** when version 21 is saved, the worker deletes the oldest `.png` and `.json` with
  `fs.unlink`, removes them from the index and regenerates the Markdown file.
* Version numbers keep counting up and are never reused. After cleanup a screen might hold v5 to v24.

---

## 3. UI/UX Specifications (The Panel)

The panel is 320px wide. Showing both images at once, stacked or side by side, makes designs too
small to read. The panel therefore shows **one image at a time with a Before/After toggle**, called
the "blink" layout.

### 3.1 Empty state (listening)

* **Condition:** the plugin is running but no captures exist yet for this workspace.
* **UI:** an `EmptyState` with a neutral `Badge` "Listening". Use a Badge rather than a Spinner,
  because nothing is actually loading.
* **Text:** *"Ready and listening. Ask the agent to make a change in Figma to see your before/after
  history here."*
* **Secondary text:** *"Tip: add one line to your agent instructions so every change is captured."*
  Next to it, a button that shows the line to copy (from 2.1, path A).

### 3.2 Blink compare view (default once there is history)

When `history_updated` arrives, or stored history exists, render these from top to bottom:

1. **Header:** `Heading` "Before / After" and an `IconButton` (Settings).
2. **Active screen:** a `Select` listing the screens in this workspace. It defaults to the first
   screen captured in the most recent run.
3. **Version selectors:** a `Row` with two `Select`s.
   * "Before" defaults to the previous version, e.g. "v1 · 10:14 am".
   * "After" defaults to the newest version, e.g. "v2 · Latest".
   * When a screen has only one version, Before shows "None yet" and the toggle shows After only.
4. **Toggle:** a `Row` with two `Button`s acting as a segmented control: `[ Before ] [ After ]`.
   * The active button is `variant="solid"` and the other is `variant="outline"`.
   * The toggle changes which image is shown below.
5. **Canvas:** one `<Image size="full" fit="contain">` showing the selected version.
   * Clicking the toggle quickly lets the user "blink" between the two versions to spot changes.
   * If that version has no image, show "No image captured for this version" instead.
6. **Context `Callout`:**
   * **Prompt:** the prompt behind the After version if known; otherwise the agent's terminal title,
     labelled "Task".
   * **Fact diff:** a plain-language summary that the worker computes deterministically by
     comparing the two JSON files, e.g. *"3 text layers changed, 1 colour changed, 2 layers added."*
     No LLM is used.
   * Note: when the agent rebuilds a layer, Figma gives it a new ID. The diff reports that as
     "removed + added". It should match by name and path as a second try.
7. **Detail and actions:**
   * `Collapsible` "Changed elements": a `List` of the changed layer names from the diff.
   * `Button` "Ask agent to explain":
     * uses `terminal.sendText` to send the agent a short request with the **path** to a saved
       diff file;
     * disabled unless the agent is idle (`done` or `waiting`).
   * Primary `Button` "Restore Before version":
     * sends a restore request with **both** the Before PNG path (how it looked) and the JSON path
       (its structure);
     * disabled unless the agent is idle;
     * the restore is captured as a new version like any other change.

---

## 4. Edge Cases & Lifecycle

* **Restarts.** On `activate`, the worker loads `history` from `orca.storage`. It drops entries
  whose files are missing and posts the state, so the panel fills in straight away. The panel also
  asks for it with `plugin.request('history.get')` when it opens.
* **Multi-screen edits.** If one run edits 3 screens, 3 versions are saved, one per screen. The
  Active screen `Select` lists all 3 and defaults to the first.
* **Workspaces.** History is kept per workspace (each agent event carries `workspaceId`). The panel
  shows the focused workspace's history and switches on `workspace.changed`.
* **Errors.**
  * A failed download or Figma API call (timeout, 403, 429) is posted as `capture_error`, saved to
    `orca.storage` as `lastError`, and shown as a `Callout tone="danger"` with a "Dismiss" button.
  * A 429 says "Figma's usage limit was reached; this run's screens were not saved" and gives the
    retry time.
  * A 403 or invalid token (Path B only) shows a "Connect Figma" `EmptyState` with an `Input`. The
    new token is saved to the plugin's secrets. Path A capture keeps working regardless.
* **Agent not following the screenshot instruction.** The version is still recorded, with "No
  image". The empty state's tip explains how to fix it.

---

## 5. Build order

1. **Riskiest step first.** Worker sees an agent's Figma MCP call, harvests one `get_screenshot`
   image, saves it to `captures/`, and the panel shows it with `<Image>`.
2. Index in `orca.storage`, version numbering and the 20-version limit.
3. Blink view: screen picker, version pickers, toggle and image.
4. Structure capture and the deterministic fact diff, including "Changed elements".
5. Markdown history file, "Ask agent to explain" and "Restore".
6. Error states, the optional REST fallback with token entry, and README instructions.
