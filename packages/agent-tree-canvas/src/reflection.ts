/** Plugin-owned inspection and Remote registration for an unmodified DSH Host. */
import { TYPERT_REMOTE } from './remote.ts'
import model from './service-model.json' with { type: 'json' }

/** Reflection consumed through the stock ./typert export. */
export const TYPERT = {
  package: '@deepseek-ai/dsh-agent-tree-canvas', face: 'host', schemas: [],
  get invocations() { return TYPERT_REMOTE.descriptors },
  model,
}
