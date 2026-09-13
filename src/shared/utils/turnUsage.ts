import { isAgentEvent } from './eventUtils'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from './runTelemetry'

export function userMessageAts(
  messages: ReadonlyArray<{ role: string; at?: string; synthetic?: boolean }>
): Array<string | undefined> {
  const ats: Array<string | undefined> = []
  for (const message of messages) {
    if (message.role === 'user' && !message.synthetic) ats.push(message.at)
  }
  return ats
}

export function userTurnCount(
  messages: ReadonlyArray<{ role: string; synthetic?: boolean }>
): number {
  let n = 0
  for (const message of messages) {
    if (message.role === 'user' && !message.synthetic) n += 1
  }
  return n
}

/**
 * Assign each persisted `step_usage` to the latest user turn whose `at` is <= the event time.
 */
export function turnUsageFromPersistedEvents(
  events: ReadonlyArray<{ at?: string; event?: unknown }>,
  userAts: readonly (string | undefined)[]
): StepUsageTotals[] {
  const n = userAts.length
  if (n === 0) return []
  const slots = Array.from({ length: n }, () => emptyStepUsageTotals())
  const userMs = userAts.map((at) => {
    if (!at) return null
    const ms = Date.parse(at)
    return Number.isFinite(ms) ? ms : null
  })

  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    const partial = stepUsageFromEvent(row.event)
    if (!partial) continue
    const eventMs = row.at ? Date.parse(row.at) : Number.NaN
    let idx = 0
    if (Number.isFinite(eventMs)) {
      for (let i = 0; i < userMs.length; i++) {
        const started = userMs[i]
        if (started != null && started <= eventMs) idx = i
      }
    } else {
      idx = n - 1
    }
    slots[idx] = mergeStepUsageTotals(slots[idx]!, partial)
  }
  return slots
}

export function alignTurnUsageSlots(
  slots: readonly StepUsageTotals[],
  userCount: number,
  resetLast: boolean
): StepUsageTotals[] {
  const n = Math.max(0, userCount)
  const next = slots.slice(0, n).map((slot) => ({ ...slot }))
  while (next.length < n) next.push(emptyStepUsageTotals())
  if (resetLast && n > 0) next[n - 1] = emptyStepUsageTotals()
  return next
}
