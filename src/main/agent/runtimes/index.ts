import type { RuntimeKind, RunRuntime } from './types'
import { localRuntime } from './local'

const runtimes = new Map<RuntimeKind, RunRuntime>([['local', localRuntime]])

/** Resolve an execution substrate; local is the default and always present. */
export function getRuntime(kind: RuntimeKind = 'local'): RunRuntime {
  const runtime = runtimes.get(kind)
  if (!runtime) {
    throw new Error(`Runtime "${kind}" is not configured (available: ${[...runtimes.keys()].join(', ')})`)
  }
  return runtime
}
