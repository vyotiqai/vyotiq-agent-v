import { useEffect, useState } from 'react'
import { parseReviewDiff } from '@renderer/features/inspector/reviewDiff'

/** Past this the diff is a rewrite, and a bar on every line says nothing the header's badge does not. */
const CHANGED_LINES_MAX = 5_000

/**
 * The new-side numbers of the added lines in a `git diff`-shaped text: where
 * the file now differs. None past the cap — a bar on part of a rewrite would
 * say the rest is untouched.
 */
export function addedLineNumbers(diff: string): number[] {
  const out: number[] = []
  const parsed = parseReviewDiff(diff, CHANGED_LINES_MAX)
  if (parsed.truncated) return out
  for (const hunk of parsed.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' && line.newN != null) out.push(line.newN)
    }
  }
  return out
}

type TaskChangedLinesArgs = {
  workspacePath: string | null
  runId: string | null
  path: string | null
  /** The task edited this file (its marks say so); nothing is asked of main otherwise. */
  changed: boolean
  revision: string
}

/** One open file as this task changed it: where, and by how much. */
export type TaskChangedFile = {
  /** Null while there is nothing to mark. */
  lines: readonly number[] | null
  /** Exact, or null when main could not count them. */
  add: number | null
  del: number | null
}

const NOTHING: TaskChangedFile = { lines: null, add: null, del: null }

/**
 * One open file as the task changed it, from the task's own record of it (its
 * first before-image against the file now) — the Changes tab's diff, as line
 * numbers and its counts. Read again when `revision` moves: a save, a run's
 * end, a keep or undo.
 */
export function useTaskChangedFile({ workspacePath, runId, path, changed, revision }: TaskChangedLinesArgs): TaskChangedFile {
  const [answer, setAnswer] = useState<{ key: string; file: TaskChangedFile } | null>(null)
  const key = workspacePath && runId && path && changed ? `${workspacePath}\u0000${runId}\u0000${path}` : null

  useEffect(() => {
    const api = window.vyotiq
    if (!key || !workspacePath || !runId || !path || !api?.taskFileDiff) return
    let cancelled = false
    void api.taskFileDiff({ workspacePath, runId, path }).then((res) => {
      if (cancelled) return
      const lines = res.ok && res.data.diff && !res.data.full ? addedLineNumbers(res.data.diff) : []
      setAnswer({
        key,
        file: {
          lines: lines.length > 0 ? lines : null,
          add: res.ok && res.data.add != null && res.data.del != null ? res.data.add : null,
          del: res.ok && res.data.add != null && res.data.del != null ? res.data.del : null
        }
      })
    })
    return () => {
      cancelled = true
    }
  }, [key, workspacePath, runId, path, revision])

  return answer && answer.key === key ? answer.file : NOTHING
}

/** {@link useTaskChangedFile}'s line numbers alone. */
export function useTaskChangedLines(args: TaskChangedLinesArgs): readonly number[] | null {
  return useTaskChangedFile(args).lines
}
