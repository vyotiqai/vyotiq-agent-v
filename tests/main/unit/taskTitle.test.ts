import { describe, expect, it } from 'vitest'
import {
  SPAWN_PREFIX,
  stripGoalMarkdown,
  taskTitleFromGoal,
  taskTitleFromUrl
} from '@shared/utils/taskTitle'

/**
 * The goal of audit run 95e872da, verbatim from status.json: a `vyotiq://`
 * deep link pasted into the composer. It reached the inbox title as 80 chars of
 * percent-encoded path, so the run was unidentifiable in a list.
 */
const PASTED_DEEP_LINK =
  'vyotiq://run/126a6ea6-e06f-4013-91af-b9f7e050ae27?ws=C%3A%5CUsers%5Cajay%5CDocuments%5CVYOTIQ%20-%20AGENT%20V%5CVYOTIQ%20-%20AGENT%20V'

describe('taskTitleFromGoal on a URL goal', () => {
  it('names a pasted vyotiq deep link by its run, not by its query string', () => {
    const title = taskTitleFromGoal(PASTED_DEEP_LINK)
    expect(title).toBe('run/126a6ea6-e06f-4013-91af-b9f7e050ae27')
    expect(title).not.toContain('://')
    expect(title).not.toContain('ws=')
    expect(title).not.toContain('%3A')
    expect(title.length).toBeLessThanOrEqual(48)
  })

  it('keeps the run id recognisable: the short form matches the title', () => {
    const title = taskTitleFromGoal(PASTED_DEEP_LINK)
    expect(title).toContain('126a6ea6')
  })

  it('names an http(s) goal by host and path, dropping query and fragment', () => {
    expect(taskTitleFromGoal('https://example.com/docs/run-1?tab=logs#top')).toBe(
      'example.com/docs/run-1'
    )
    expect(taskTitleFromGoal('https://www.example.com/')).toBe('example.com')
    expect(taskTitleFromGoal('http://example.com')).toBe('example.com')
  })

  it('never returns an empty title or a bare scheme', () => {
    for (const url of [PASTED_DEEP_LINK, 'https://example.com/', 'vyotiq://run/abc-123']) {
      const title = taskTitleFromGoal(url)
      expect(title.trim().length).toBeGreaterThan(0)
      expect(title.endsWith('://')).toBe(false)
    }
  })

  it('clips a very long URL path rather than spilling past the title budget', () => {
    const title = taskTitleFromUrl(`https://example.com/${'segment/'.repeat(20)}end`)
    expect(title.length).toBeLessThanOrEqual(48)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('taskTitleFromGoal leaves a plain goal alone', () => {
  it('keeps markdown, identifier and glob handling exactly as before', () => {
    expect(taskTitleFromGoal('**Fix** the flaky `updater` test\n\nSteps: …')).toBe(
      'Fix the flaky updater test'
    )
    expect(taskTitleFromGoal('Rename max_retry_count in src/*.ts and lib/*.js')).toBe(
      'Rename max_retry_count in src/*.ts and lib/*.js'
    )
    expect(taskTitleFromGoal('# Heading\nbody')).toBe('Heading')
    expect(taskTitleFromGoal('- [x] done thing')).toBe('done thing')
    expect(taskTitleFromGoal('> quoted line')).toBe('quoted line')
    expect(taskTitleFromGoal('chat')).toBe('Untitled task')
  })

  it('still drops a spawn prefix', () => {
    expect(taskTitleFromGoal('Spawn instances for: Audit the updater')).toBe('Audit the updater')
    expect(SPAWN_PREFIX.test('Spawn instances for: x')).toBe(true)
  })

  it('leaves a sentence that merely contains :// untouched', () => {
    const sentence = 'Mirror the docs at https://example.com/docs into site/'
    expect(taskTitleFromGoal(sentence)).toBe(sentence)
    const midWord = 'Fix the redirect when users paste http://x into the composer'
    expect(taskTitleFromGoal(midWord)).toBe(midWord)
    const trailing = 'Read this: file:///C:/Users/ajay/notes.md'
    expect(taskTitleFromGoal(trailing)).toBe(trailing)
  })

  it('still uses the raw goal when the markdown strip leaves nothing', () => {
    expect(taskTitleFromGoal('~~~\n```\n~~~')).toBe('~~~\n```\n~~~')
  })

  it('keeps stripGoalMarkdown itself unchanged', () => {
    expect(stripGoalMarkdown('**Fix** the `updater` test')).toBe('Fix the updater test')
  })
})