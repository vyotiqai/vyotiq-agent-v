/** Safe tool-arg reads at execution time — not a pre-dispatch validation gate. */

export function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

export function readTrimmed(args: Record<string, unknown>, key: string): string | undefined {
  const value = readString(args, key)
  return value !== undefined ? value.trim() : undefined
}

const PATH_KEYS = ['path', 'file', 'filepath', 'filename'] as const

export function readPathArg(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = readTrimmed(args, key)
    if (value) return value
  }
  return undefined
}

export function readEditBody(args: Record<string, unknown>): {
  contents?: string
  diff?: string
} {
  return {
    contents: readString(args, 'contents') ?? readString(args, 'content'),
    diff: readString(args, 'diff')
  }
}

export function requirePathArg(tool: string, args: Record<string, unknown>): string {
  const path = readPathArg(args)
  if (!path) throw new Error(`${tool} requires path`)
  return path
}
