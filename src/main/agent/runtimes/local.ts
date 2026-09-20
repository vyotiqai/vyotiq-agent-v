import type { AgentEvent, ChatMessage } from '../../../shared/ipc'
import { runAgent } from '../loop'
import { cancelRun, enqueueFollowUp, promoteFollowUp } from '../runRegistry'
import type {
  RunHandle,
  RunRuntime,
  RuntimeCapabilities,
  RuntimeRecord,
  RuntimeStartInput
} from './types'

/**
 * In-app execution: the agent loop runs inside the Electron main process.
 *
 * This adapter is a thin shell over `runAgent` on purpose. The local path is
 * the reference behavior every other runtime is compared against, so it must
 * not reorder, filter, or synthesize events — `events()` yields exactly what
 * `runAgent` yields, in order.
 */
const LOCAL_CAPABILITIES: RuntimeCapabilities = {
  cancel: true,
  steer: true,
  // Nothing survives the process, so there is no saved state to reconnect to.
  // A logical resume is a NEW run started from disk, not a reattachment.
  reconnect: false,
  approvals: true,
  questions: true
}

class LocalRunHandle implements RunHandle {
  readonly kind = 'local' as const
  readonly capabilities = LOCAL_CAPABILITIES

  constructor(private readonly input: RuntimeStartInput) {}

  events(): AsyncGenerator<AgentEvent> {
    return runAgent(this.input)
  }

  async cancel(): Promise<void> {
    cancelRun(this.input.runId)
  }

  async steer(message: ChatMessage): Promise<void> {
    const queued = enqueueFollowUp(this.input.runId, message)
    if (!queued.ok) throw new Error(queued.error)
    // Steering means "act on this now", which is the promote path; a passive
    // enqueue would sit in the queue until the turn ended on its own.
    const promoted = promoteFollowUp(this.input.runId, queued.id)
    if (!promoted.ok) throw new Error(promoted.error)
  }

  async reconnect(): Promise<void> {
    throw new Error('The local runtime has no saved session to reconnect to')
  }

  record(): RuntimeRecord {
    return { kind: 'local', version: 1 }
  }

  dispose(): void {
    // The loop owns its own teardown (runRegistry clears the slot in its
    // finally). Detaching here must not abort it: dispose is not cancel.
  }
}

export const localRuntime: RunRuntime = {
  kind: 'local',
  capabilities: LOCAL_CAPABILITIES,
  async isAvailable() {
    return { ok: true }
  },
  start: (input) => new LocalRunHandle(input)
}
