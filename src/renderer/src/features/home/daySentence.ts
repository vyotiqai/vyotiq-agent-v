/*
  Home's day sentence, as data: what Home already knows, said once in plain
  words. Facts are the parts a person scans for (counts, a time, a file count)
  and each is a control; the words between them are joiners and stay muted,
  so the facts stand out by contrast with their neighbours, not by weight.

  Pure: Home hands in counts it read from the sources its sections read
  (active runs, the navigator's sections, schedules, git status, the week's
  receipts, connection health) and gets back the segments to draw.
*/

export type FactKey = 'needs' | 'failed' | 'running' | 'review' | 'schedule' | 'changes' | 'week'

export type Fact = { key: FactKey; text: string }

export type Segment =
  | { kind: 'words'; text: string }
  | { kind: 'fact'; fact: Fact }
  /** The person's name in the greeting: brighter than the joiners, quieter than a fact. */
  | { kind: 'name'; text: string }

export type DayFacts = {
  /** Tasks parked on an approval or a question. */
  needs: number
  /**
   * What else Needs you lists: a provider with no key, an MCP server that
   * won't connect. Counted apart from tasks so the sentence never says
   * "Nothing needs you" over a section that lists one.
   */
  issues: number
  failed: number
  running: number
  review: number
  /** The soonest enabled schedule's next time, if any. */
  nextSchedule: Date | null
  /** Uncommitted files summed over open workspaces, and how many workspaces hold them. */
  changes: { files: number; workspaces: number; name: string | null }
  /** Tasks finished in the last seven days, from the week's receipts. */
  doneThisWeek: number | null
  /** Settings › Appearance › Your name. Empty: no greeting. */
  userName: string
  now: Date
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "a, b and c" over segment runs. */
function joinList(parts: Segment[][]): Segment[] {
  const out: Segment[] = []
  parts.forEach((part, i) => {
    if (i > 0) out.push({ kind: 'words', text: i === parts.length - 1 ? ' and ' : ', ' })
    out.push(...part)
  })
  return out
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function clock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** "at 16:00", "tomorrow at 09:00", "on Mon at 09:00" within the week, "on 30 Oct at 09:00" past it. */
export function whenText(next: Date, now: Date): string {
  if (sameDay(next, now)) return `at ${clock(next)}`
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (sameDay(next, tomorrow)) return `tomorrow at ${clock(next)}`
  // A bare weekday is only unambiguous inside the coming six days.
  const weekOut = new Date(now)
  weekOut.setDate(now.getDate() + 6)
  weekOut.setHours(23, 59, 59, 999)
  const day =
    next.getTime() <= weekOut.getTime()
      ? next.toLocaleDateString(undefined, { weekday: 'short' })
      : next.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `on ${day} at ${clock(next)}`
}

/** Good morning until noon, afternoon until six, evening after (and before five). */
export function greetingFor(now: Date): string {
  const h = now.getHours()
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function daySentence(f: DayFacts): Segment[] {
  const fact = (key: FactKey, text: string): Segment[] => [{ kind: 'fact', fact: { key, text } }]
  const out: Segment[] = []

  const name = f.userName.trim()
  if (name) out.push({ kind: 'words', text: `${greetingFor(f.now)}, ` }, { kind: 'name', text: name }, { kind: 'words', text: '. ' })

  // What wants something: the first sentence, most urgent first.
  const wants: Segment[][] = []
  // "and 1 is running" leans on the noun before it, so it may only follow a
  // fact about tasks alone: after "1 connection needs you" it would read as
  // a connection running.
  let afterTasks = false
  const lead = (n: number): string => (afterTasks ? `${n} ${n === 1 ? 'is' : 'are'}` : plural(n, 'task is', 'tasks are'))
  if (f.needs > 0 || f.issues > 0) {
    const tasks = f.needs > 0 ? plural(f.needs, 'task', 'tasks') : ''
    const issues = f.issues > 0 ? plural(f.issues, 'connection', 'connections') : ''
    const one = f.needs + f.issues === 1
    wants.push(fact('needs', `${[tasks, issues].filter(Boolean).join(' and ')} ${one ? 'needs' : 'need'} you`))
    afterTasks = f.issues === 0
  }
  if (f.failed > 0) {
    wants.push(fact('failed', `${plural(f.failed, 'task', 'tasks')} failed`))
    afterTasks = true
  }
  if (f.running > 0) {
    wants.push(fact('running', `${lead(f.running)} running`))
    afterTasks = true
  }
  if (f.review > 0) wants.push(fact('review', `${lead(f.review)} ready for review`))
  if (wants.length === 0) out.push({ kind: 'words', text: 'Nothing needs you.' })
  else out.push(...joinList(wants), { kind: 'words', text: '.' })

  if (f.nextSchedule) {
    out.push({ kind: 'words', text: ' Next ' }, ...fact('schedule', `scheduled run ${whenText(f.nextSchedule, f.now)}`), {
      kind: 'words',
      text: '.'
    })
  }

  if (f.changes.files > 0) {
    out.push({ kind: 'words', text: ' ' }, ...fact('changes', plural(f.changes.files, 'uncommitted file', 'uncommitted files')))
    out.push({
      kind: 'words',
      text: f.changes.workspaces > 1 ? ` across ${f.changes.workspaces} workspaces.` : f.changes.name ? ` in ${f.changes.name}.` : '.'
    })
  }

  // A quiet day still says something true: what the week got done.
  if (wants.length === 0 && f.doneThisWeek) {
    out.push({ kind: 'words', text: ' You finished ' }, ...fact('week', plural(f.doneThisWeek, 'task', 'tasks')), {
      kind: 'words',
      text: ' this week.'
    })
  }
  return out
}

/** The sentence as one plain string: what a test reads and what voice would say. */
export function sentenceText(segments: readonly Segment[]): string {
  return segments.map((s) => (s.kind === 'fact' ? s.fact.text : s.text)).join('')
}

/** The fact keys a sentence holds, in order. */
export function factKeys(segments: readonly Segment[]): FactKey[] {
  return segments.flatMap((s) => (s.kind === 'fact' ? [s.fact.key] : []))
}
