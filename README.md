# Before / After

An Orca right-sidebar plugin for designers. When an agent in Orca changes a Figma design, the plugin
saves the screens it changed. In the side panel you can then blink between a **Before** and an
**After** version of each screen, read a short summary of what changed, ask the agent to explain the
change, or ask it to restore an older version.

The full feature spec is in [FEATURES.md](FEATURES.md).

## Set up (one line)

The plugin saves the screenshots your agent takes through the Figma MCP, so no Figma token is
needed. To make sure every change gets a screenshot, add this line to your agent instructions (for
example `CLAUDE.md` in your project):

```
After changing a Figma screen, call get_screenshot (and get_metadata) on each top-level frame you changed.
```

`get_metadata` is optional. It lets the panel list which layers changed.

Optional backup: put a Figma personal access token in `FIGMA_ACCESS_TOKEN`, or paste one in the
panel's settings. The plugin then asks Figma's REST API for any screen the agent did not
screenshot. Figma limits these requests heavily on Starter plans and View seats.

## What it saves and where

- Images and layer outlines are saved in `captures/` inside the plugin folder. This folder is in
  `.gitignore`.
- The plugin keeps the last 20 versions per screen.
- In each workspace it also writes `.orca-figma-history.md`, a table of every saved version, so the
  agent can read the history. Add that file to your project's `.gitignore` if you don't want it
  committed.

## Limits

- Only agents running in Orca terminals are watched. Agents on SSH or WSL hosts are not hooked yet.
- Edits made by hand in Figma are not captured.
- The Restore and Ask buttons type into the agent's terminal, so they only work while the agent is
  idle.

## Develop

```sh
orca plugin validate .
orca plugin test .          # worker, diff and panel tests
orca plugin check .         # renders the panel in a few scenarios
npx -p typescript tsc -p .  # type-check
orca plugin dev watch .     # load into Orca, stream logs, reload on save
```

Code layout:
- `src/worker.ts`: hooks, events, capture and storage.
- `src/figma.ts`: reads Figma MCP calls.
- `src/diff.ts`: the layer comparison.
- `src/history.ts`: the history model.
- `src/panel.tsx`: the panel UI.
- `src/protocol.ts`: the requests and events shared by the panel and the worker.
