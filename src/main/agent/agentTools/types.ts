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
  /**
   * SHA-256 of the module's bytes.
   *
   * What an approval is granted against. mtime answers "has this file changed
   * since we last scanned"; only the content answers "is this the code the user
   * said yes to", which is what an "always allow" has to survive a rewrite.
   */
  contentHash: string
}

/** Outcome of running a tool module in a utility child. */
export type AgentToolRuntimeResult = {
  ok: boolean
  result?: unknown
  error?: string
  durationMs: number
}
