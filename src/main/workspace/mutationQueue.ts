import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'

const IDLE: Promise<void> = Promise.resolve()

type WorkspaceMutationState = {
  exclusive: Promise<void>
  paths: Map<string, Promise<void>>
}

const workspaces = new Map<string, WorkspaceMutationState>()

function mutationKey(workspacePath: string): string {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function pathKey(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').trim()
  if (!normalized || normalized === '.') {
    throw new Error('withWorkspaceMutation requires a relative file path')
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function workspaceState(workspacePath: string): { key: string; state: WorkspaceMutationState } {
  const key = mutationKey(workspacePath)
  let state = workspaces.get(key)
  if (!state) {
    state = { exclusive: IDLE, paths: new Map() }
    workspaces.set(key, state)
  }
  return { key, state }
}

function tryPrune(key: string, state: WorkspaceMutationState): void {
  if (state.paths.size === 0 && state.exclusive === IDLE && workspaces.get(key) === state) {
    workspaces.delete(key)
  }
}

function chainMutation<T>(
  previous: Promise<void>,
  setHead: (next: Promise<void>) => void,
  onSettled: (settled: Promise<void>) => void,
  operation: () => T | Promise<T>
): Promise<T> {
  let release: (() => void) | undefined
  const reservation = new Promise<void>((resolve) => {
    release = resolve
  })
  setHead(reservation)
  const run = previous.then(operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  setHead(settled)
  void settled.then(() => {
    onSettled(settled)
    release?.()
  })
  return run
}

function joinWaits(waits: Promise<void>[]): Promise<void> {
  if (waits.length === 0) return IDLE
  if (waits.length === 1) return waits[0] ?? IDLE
  return Promise.all(waits).then(() => undefined)
}

/** Chain a file mutation behind in-flight work on the same relative path only. */
export function withWorkspaceMutation<T>(
  workspacePath: string,
  relPath: string,
  operation: () => T | Promise<T>
): Promise<T> {
  const relKey = pathKey(relPath)
  const { key, state } = workspaceState(workspacePath)
  const previous = joinWaits([state.exclusive, state.paths.get(relKey) ?? IDLE])
  return chainMutation(
    previous,
    (next) => {
      state.paths.set(relKey, next)
    },
    (settled) => {
      if (state.paths.get(relKey) === settled) state.paths.delete(relKey)
      tryPrune(key, state)
    },
    operation
  )
}

/**
 * Workspace-wide tree lock: waits for in-flight per-path chains and blocks new
 * path mutations until `operation` settles.
 */
export function withExclusiveWorkspaceMutation<T>(
  workspacePath: string,
  operation: () => T | Promise<T>
): Promise<T> {
  const { key, state } = workspaceState(workspacePath)
  const previous = joinWaits([state.exclusive, ...state.paths.values()])
  return chainMutation(
    previous,
    (next) => {
      state.exclusive = next
    },
    (settled) => {
      if (state.exclusive === settled) state.exclusive = IDLE
      tryPrune(key, state)
    },
    operation
  )
}
