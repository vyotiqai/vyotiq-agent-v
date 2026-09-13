import type { ProviderId } from '../../shared/ipc'

/**
 * Per-run provider/model memory (main side).
 *
 * Every chatStart invoke re-resolves provider/model from live settings, so a
 * model changed in a different chat session would otherwise bleed into this
 * run's later invokes that have no renderer to pass an explicit selection
 * (follow-up promote, goal relaunch). The run loop records the resolved
 * selection at each invoke start; those main-originated invokes recall it.
 */
const MAX_ENTRIES = 512

const selections = new Map<string, { provider: ProviderId; model: string }>()

export function rememberRunModelSelection(
  runId: string,
  provider: ProviderId,
  model: string
): void {
  selections.delete(runId)
  selections.set(runId, { provider, model })
  if (selections.size > MAX_ENTRIES) {
    const oldest = selections.keys().next().value
    if (oldest !== undefined) selections.delete(oldest)
  }
}

export function recallRunModelSelection(
  runId: string
): { provider: ProviderId; model: string } | null {
  return selections.get(runId) ?? null
}

/** Drop in-memory run model selections (tests). */
export function clearRunModelSelectionForTests(): void {
  selections.clear()
}
