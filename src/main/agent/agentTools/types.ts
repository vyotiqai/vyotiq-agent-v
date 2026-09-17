/** Header comment every agent-built tool module must start with. */
export type AgentToolHeader = {
  /** Safe, unique tool name (see pathSafeName). */
  name: string
  /** Short description surfaced to the model. */
  description: string
  /** Loose JSON-schema object describing handler(args). */
  inputSchema: Record<string, unknown>
}

/** A scanned agent-built tool: header plus where/how to run it. */
export type AgentToolDef = AgentToolHeader & {
  /** Absolute path of the .mjs module. */
  modulePath: string
  /** Stable per-file identity (name + mtimeMs) used for change detection. */
  fingerprint: string
}

/** Outcome of running a tool module in a utility child. */
export type AgentToolRuntimeResult = {
  ok: boolean
  result?: unknown
  error?: string
  durationMs: number
}
