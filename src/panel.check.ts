// `orca plugin check` renders the panel with the worker on a fresh host, once per scenario.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  listening: {
    results: { 'workspace.readContext': { branch: 'main', displayName: 'design', terminals: [] } }
  },
  error: {
    storage: { lastError: { message: 'Figma’s usage limit was reached, so this run’s screens were not all saved.', at: 1 } }
  }
})
