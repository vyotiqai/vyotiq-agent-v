import { describe, expect, it } from 'vitest'
import {
  daySentence,
  factKeys,
  greetingFor,
  sentenceText,
  whenText,
  type DayFacts
} from '@renderer/features/home/daySentence'

const NOW = new Date(2026, 9, 17, 10, 30) // Sat 17 Oct 2026, 10:30 local

function facts(over: Partial<DayFacts> = {}): DayFacts {
  return {
    needs: 0,
    issues: 0,
    failed: 0,
    running: 0,
    review: 0,
    nextSchedule: null,
    changes: { files: 0, workspaces: 0, name: null },
    doneThisWeek: null,
    userName: '',
    now: NOW,
    ...over
  }
}

const text = (over: Partial<DayFacts>): string => sentenceText(daySentence(facts(over)))
const at = (h: number, m = 0, dayOffset = 0): Date => new Date(2026, 9, 17 + dayOffset, h, m)
const clock = (d: Date): string => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

describe('daySentence', () => {
  it('lists what wants you, most urgent first, joined as a sentence', () => {
    expect(text({ needs: 2, running: 1, review: 3 })).toBe('2 tasks need you, 1 is running and 3 are ready for review.')
    expect(text({ failed: 1, review: 1 })).toBe('1 task failed and 1 is ready for review.')
    expect(text({ running: 3, review: 1 })).toBe('3 tasks are running and 1 is ready for review.')
    expect(text({ review: 1 })).toBe('1 task is ready for review.')
  })

  it('counts connections that need you, so it never says nothing needs you over one', () => {
    expect(text({ issues: 1 })).toBe('1 connection needs you.')
    expect(text({ needs: 1, issues: 1 })).toBe('1 task and 1 connection need you.')
    // A bare "1 is running" after a connection would read as the connection running.
    expect(text({ issues: 1, running: 1 })).toBe('1 connection needs you and 1 task is running.')
    expect(text({ needs: 1, issues: 1, review: 2 })).toBe('1 task and 1 connection need you and 2 tasks are ready for review.')
    expect(text({ issues: 1, failed: 1, running: 1 })).toBe('1 connection needs you, 1 task failed and 1 is running.')
    expect(text({ needs: 1 })).toBe('1 task needs you.')
  })

  it('says nothing needs you on a quiet day, and what the week got done', () => {
    expect(text({})).toBe('Nothing needs you.')
    expect(text({ doneThisWeek: 4 })).toBe('Nothing needs you. You finished 4 tasks this week.')
    // A day with work going says the work, not the week.
    expect(text({ running: 1, doneThisWeek: 4 })).toBe('1 task is running.')
  })

  it('names the next scheduled run and the uncommitted files', () => {
    const next = at(16)
    expect(text({ review: 1, nextSchedule: next, changes: { files: 4, workspaces: 1, name: 'repo' } })).toBe(
      `1 task is ready for review. Next scheduled run at ${clock(next)}. 4 uncommitted files in repo.`
    )
    expect(text({ changes: { files: 1, workspaces: 1, name: 'repo' } })).toBe('Nothing needs you. 1 uncommitted file in repo.')
    expect(text({ changes: { files: 5, workspaces: 2, name: null } })).toBe('Nothing needs you. 5 uncommitted files across 2 workspaces.')
  })

  it('greets by name only when one is set', () => {
    expect(text({ userName: 'Ajay', needs: 1 })).toBe('Good morning, Ajay. 1 task needs you.')
    expect(text({ userName: '   ', needs: 1 })).toBe('1 task needs you.')
    const segments = daySentence(facts({ userName: 'Ajay' }))
    expect(segments.find((s) => s.kind === 'name')).toEqual({ kind: 'name', text: 'Ajay' })
  })

  it('makes every count a fact a person can open', () => {
    const segments = daySentence(
      facts({ needs: 1, failed: 1, running: 1, review: 1, nextSchedule: at(16), changes: { files: 2, workspaces: 1, name: 'r' } })
    )
    expect(factKeys(segments)).toEqual(['needs', 'failed', 'running', 'review', 'schedule', 'changes'])
    expect(factKeys(daySentence(facts({ doneThisWeek: 3 })))).toEqual(['week'])
  })
})

describe('whenText', () => {
  it('says at, tomorrow, a weekday inside the week, and a date past it', () => {
    expect(whenText(at(16), NOW)).toBe(`at ${clock(at(16))}`)
    expect(whenText(at(9, 0, 1), NOW)).toBe(`tomorrow at ${clock(at(9, 0, 1))}`)
    const mon = at(9, 0, 2)
    expect(whenText(mon, NOW)).toBe(`on ${mon.toLocaleDateString(undefined, { weekday: 'short' })} at ${clock(mon)}`)
    const far = at(9, 0, 13)
    expect(whenText(far, NOW)).toBe(`on ${far.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${clock(far)}`)
  })
})

describe('greetingFor', () => {
  it('moves through the day', () => {
    expect(greetingFor(at(4))).toBe('Good evening')
    expect(greetingFor(at(5))).toBe('Good morning')
    expect(greetingFor(at(11, 59))).toBe('Good morning')
    expect(greetingFor(at(12))).toBe('Good afternoon')
    expect(greetingFor(at(17, 59))).toBe('Good afternoon')
    expect(greetingFor(at(18))).toBe('Good evening')
  })
})
