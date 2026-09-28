/**
 * Canonical id safe for the `[x] (id) content` checklist line format: any
 * whitespace or parenthesis in a raw id would break the line parser, so ids
 * are canonicalized once at write time. Deterministic, so merge-by-id stays
 * stable across todo_write calls — and the record can key a `create_plan`'s
 * raw argument ids the same way todos.json stores them.
 */
export function canonicalTodoId(id: string): string {
  return id.replace(/[\s()]+/g, '')
}

/** True when todo_write tool output still marks a task as in progress. */
export function todoContentHasInProgress(content: string): boolean {
  return content.split('\n').some((line) => line.startsWith('[~] '))
}

export type TodoFinalizeOutcome = 'done' | 'error' | 'cancelled'

/**
 * Demote in-progress checklist markers to match run-end disk semantics:
 * - done / error → pending (`[ ]`) so work can resume
 * - cancelled → cancelled (`[-]`)
 */
export function finalizeTodoContentOnRunEnd(
  content: string,
  outcome: TodoFinalizeOutcome
): string {
  if (!todoContentHasInProgress(content)) return content
  const mark = outcome === 'cancelled' ? '[-]' : '[ ]'
  return content
    .split('\n')
    .map((line) => (line.startsWith('[~] ') ? `${mark} ${line.slice(4)}` : line))
    .join('\n')
}

/** Demote interrupted in-progress tasks so reload does not keep spinners alive. */
export function finalizeInterruptedTodoContent(content: string): string {
  return finalizeTodoContentOnRunEnd(content, 'cancelled')
}
