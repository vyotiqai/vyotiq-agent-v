import type { AgentEvent } from '../../../shared/ipc'

/**
 * Execution substrate for agent runs. The local runtime executes inside the
 * Electron main process (the only implementation today); cloud runtimes plug
 * into the same seam in Phase B and stream events through the same schema.
 */
export type RuntimeKind = 'local' | 'cloud'

export interface RunRuntime {
  readonly kind: RuntimeKind
  /** Start a run; yields the same AgentEvent stream the renderer consumes. */
  start(input: import('../loop').RunAgentInput): AsyncGenerator<AgentEvent>
}
