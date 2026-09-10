import { useCallback, useEffect, useRef, useState } from 'react'
import { parseTodosJson, type TodoParsed } from '../toolUi/parsers/todo'

const POLL_MS = 2000
const LIVE_POLL_MS = 500

/**
 * Load + poll run-dir `todos.json` for the ceiling band and Plan Tasks section.
 */
export function useRunTodos(opts: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  /** When false, skip polling unless the run is live (mounted but hidden). */
  active?: boolean
  /** When false, never use the 500ms live cadence (compact rail chip). */
  live?: boolean
}): {
  data: TodoParsed | null
  loading: boolean
  /** True once the first load attempt for the current run has completed. */
  loaded: boolean
  error: string | null
  reload: (opts?: { quiet?: boolean }) => Promise<void>
} {
  const { workspacePath, runId, running = false, active = true, live = true } = opts
  const [data, setData] = useState<TodoParsed | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasRunningRef = useRef(running)
  const loadSeqRef = useRef(0)

  const load = useCallback(
    async (loadOpts?: { quiet?: boolean }) => {
      const seq = ++loadSeqRef.current
      if (!workspacePath || !runId) {
        if (seq !== loadSeqRef.current) return
        setData(null)
        setError(null)
        setLoading(false)
        setLoaded(false)
        return
      }
      if (!loadOpts?.quiet) {
        setLoading(true)
        setError(null)
      }
      try {
        const res = await window.vyotiq.readRunArtifact({
          workspacePath,
          runId,
          name: 'todos.json'
        })
        if (seq !== loadSeqRef.current) return
        if (!res.ok) {
          setData(null)
          setError(res.error)
          return
        }
        if (!res.data.exists || !res.data.content) {
          setData(null)
          setError(null)
          return
        }
        const parsed = parseTodosJson(res.data.content)
        if (!parsed) {
          setData(null)
          // Non-JSON leftovers are treated as empty; only flag real JSON parse failures.
          setError(res.data.content.trim().startsWith('{') ? 'Invalid todos.json' : null)
          return
        }
        setData(parsed)
        setError(null)
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false)
          setLoaded(true)
        }
      }
    },
    [workspacePath, runId]
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (active) void load({ quiet: true })
  }, [active, load])

  useEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = running
    if (wasRunning && !running) {
      void load({ quiet: true })
    }
  }, [running, load])

  // Poll only while active (hidden Plan dock must not start intervals).
  // Live 500ms cadence only when todos UI has items to show.
  // No live run → no interval: todos.json is written only by the agent loop,
  // the mount/active-change load covers display, and the wasRunning→!running
  // transition refetches the terminal state (audit L-12: a mounted dock must
  // not keep a 2s fallback poll ticking on an idle run forever).
  const hasVisibleTodos = (data?.items.length ?? 0) > 0
  useEffect(() => {
    if (!active || !running || !workspacePath || !runId) return
    const ms = running && live && hasVisibleTodos ? LIVE_POLL_MS : POLL_MS
    const id = window.setInterval(() => {
      void load({ quiet: true })
    }, ms)
    return () => window.clearInterval(id)
  }, [active, running, workspacePath, runId, live, hasVisibleTodos, load])

  return { data, loading, loaded, error, reload: load }
}

/** True when todos.json has at least one task. */
export function todosArtifactHasItems(content: string | null | undefined): boolean {
  if (!content?.trim()) return false
  const parsed = parseTodosJson(content)
  return (parsed?.items.length ?? 0) > 0
}
