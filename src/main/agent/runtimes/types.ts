import type { AgentEvent, ChatMessage } from '../../../shared/ipc'

/**
 * Execution substrate for agent runs.
 *
 * The local runtime executes inside the Electron main process. A cloud runtime
 * executes on a provider that keeps running when this app is closed, which is
 * what forces the shape below: a runtime is not just a source of events, it is
 * a handle to work that may outlive the window showing it.
 *
 * That distinction is why `dispose` and `cancel` are separate operations. For
 * the local runtime they would collapse into one — closing the stream ends the
 * work. For a cloud runtime, detaching a listener must NOT stop a turn the user
 * is paying for and expects to find finished later.
 */
export type RuntimeKind = 'local' | 'cloud'

/**
 * What a runtime can actually do. Every capability is false by default so a new
 * runtime cannot silently inherit a promise it does not keep. Surfaces read
 * these to render an action as unavailable rather than offering a control that
 * does nothing — a Steer button that no-ops is worse than an absent one.
 */
export type RuntimeCapabilities = {
  /** Interrupt the turn in progress without ending the session. */
  cancel: boolean
  /** Inject a user message into the turn in progress. */
  steer: boolean
  /** Rebuild state after the stream drops (reconnect, app restart). */
  reconnect: boolean
  /** Tool-approval prompts are enforced by this runtime. */
  approvals: boolean
  /** The agent can ask the user a question mid-turn. */
  questions: boolean
}

export const NO_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  cancel: false,
  steer: false,
  reconnect: false,
  approvals: false,
  questions: false
}

/**
 * Durable, runtime-specific state persisted with the run.
 *
 * Discriminated on `kind` and versioned, so a runtime that grows durable
 * state later can be told apart from one that never had any. The local
 * runtime has nothing to remember between launches: its work dies with the
 * process that hosted it.
 */
export type LocalRuntimeRecord = {
  kind: 'local'
  version: 1
}

export type RuntimeRecord = LocalRuntimeRecord

export type RuntimeStartInput = import('../loop').RunAgentInput

/**
 * A live handle to one run's execution.
 *
 * `events` is consumed exactly once per turn. The remaining operations are
 * optional at the type level only in the sense that a runtime may reject them;
 * callers must check `capabilities` first rather than calling and hoping.
 */
export interface RunHandle {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeCapabilities
  /** The event stream for this turn — the same schema the renderer consumes. */
  events(): AsyncGenerator<AgentEvent>
  /** Stop the turn in progress. Resolves once the request is acknowledged. */
  cancel(): Promise<void>
  /** Inject a user message into the turn in progress. */
  steer(message: ChatMessage): Promise<void>
  /**
   * Re-establish a dropped stream and return anything missed. Implementations
   * must be idempotent: a reconnect that re-delivers already-reconciled items
   * duplicates the transcript.
   */
  reconnect(): Promise<void>
  /** Durable state to persist with the run. */
  record(): RuntimeRecord
  /**
   * Detach local listeners. This does NOT stop remote work — a cloud turn keeps
   * running after the app closes, which is the point of running it there. Use
   * `cancel` to actually stop a turn.
   */
  dispose(): void
}

export interface RunRuntime {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeCapabilities
  /**
   * Whether this runtime can accept work right now (credentials present,
   * provider reachable). A runtime that cannot start must say so BEFORE its run
   * is marked running — falling back to another substrate would silently run
   * the user's work somewhere they did not choose.
   */
  isAvailable(): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Begin a turn and return a handle to it. */
  start(input: RuntimeStartInput): RunHandle
}
