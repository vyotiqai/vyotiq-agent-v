/**
 * What each run set through app_control, so app_status can say when a
 * setting was changed since by someone else (docs/voice-mode.md §27).
 *
 * 2026-10-16 probe: the agent set the orb to cloud, the orb was then changed
 * to pearl the way the person would in Settings, and asked which orb it used
 * the agent read "pearl", decided its own change "didn't stick" and set cloud
 * again, two runs in three, though told not to. It couldn't tell the person's
 * change from its own failure; this tells it.
 */

/** The settings app_control writes, as the agent would say them. */
const LABELS: Readonly<Record<string, string>> = {
  theme: 'the theme',
  skinId: 'the skin',
  model: 'the model new tasks start with',
  'toolApproval.mode': 'tool approvals',
  'voice.orbLook': 'the orb',
  'voice.style': 'the voice style',
  'voice.viewLayout': 'the voice layout',
  'voice.placement': 'where voice mode shows',
  'voice.speed': 'the voice speed',
  'voice.endOfTurnPatience': 'how long it waits before you’re done',
  'voice.captions': 'captions',
  'voice.earcons': 'sounds',
  'voice.speakProgress': 'spoken progress',
  'voice.pushToTalkOnly': 'hold to talk only'
}

/** Runs remembered at once: the newest. */
const MAX_RUNS = 50

const setByRun = new Map<string, Map<string, string>>()

/** Leaf values by dotted path; arrays and empty objects are skipped. */
function leaves(value: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (prefix && !Array.isArray(value)) out.set(prefix, String(value))
    return out
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) leaves(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

/**
 * A settings patch an action made for this run: what it meant to set
 * (`meant`, a part of the settings) is remembered as set by the run, with the
 * value the settings hold after it, even where it was that already.
 */
export function rememberSettingsSet(runId: string | null | undefined, meant: unknown, after: unknown): void {
  if (!runId) return
  const now = leaves(after)
  const paths = [...leaves(meant).keys()].filter((path) => LABELS[path] !== undefined && now.has(path))
  if (paths.length === 0) return
  const mine = setByRun.get(runId) ?? new Map<string, string>()
  for (const path of paths) mine.set(path, now.get(path)!)
  setByRun.delete(runId)
  setByRun.set(runId, mine)
  while (setByRun.size > MAX_RUNS) setByRun.delete(setByRun.keys().next().value!)
}

/** Settings this run set that are something else now: changed since, not by it. */
export function settingsChangedSince(runId: string | null | undefined, current: unknown): Array<{ what: string; set: string; now: string }> {
  const mine = runId ? setByRun.get(runId) : undefined
  if (!mine) return []
  const now = leaves(current)
  const out: Array<{ what: string; set: string; now: string }> = []
  for (const [path, set] of mine) {
    const value = now.get(path)
    if (value !== undefined && value !== set) out.push({ what: LABELS[path] ?? path, set, now: value })
  }
  return out
}

/** Tests only. */
export function resetSettingsSetForTests(): void {
  setByRun.clear()
}
