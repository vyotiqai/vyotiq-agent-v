import { describe, expect, it } from 'vitest'
import {
  CODE_ON_SCREEN,
  DETAILS_ON_SCREEN,
  SentenceSplitter,
  fallbackSummary,
  isStopPhrase,
  speakIdentifier,
  toSpeakable
} from '@main/voice/speechText'

describe('toSpeakable', () => {
  it('drops code blocks and tables, keeps the prose around them', () => {
    const md = 'I changed the loop.\n\n```ts\nconst a = 1\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nTests pass.'
    expect(toSpeakable(md)).toBe('I changed the loop. Tests pass.')
  })

  it('points at the screen when the answer was only code', () => {
    expect(toSpeakable('```ts\nexport const x = 1\n```')).toBe(CODE_ON_SCREEN)
  })

  it('speaks paths as their file name and links as their text', () => {
    expect(toSpeakable('See src/main/agent/loop.ts:4008 and [the docs](https://x.dev/a).')).toBe(
      'See loop and the docs.'
    )
    expect(toSpeakable('Details at https://example.com/very/long?q=1 for later')).toBe(
      'Details at a link on screen for later.'
    )
  })

  it('reads short identifiers as words and leaves long ones alone', () => {
    expect(toSpeakable('I renamed `runAgent` and `MAX_DICTATION_BYTES`.')).toBe(
      'I renamed run agent and MAX DICTATION BYTES.'
    )
    expect(speakIdentifier('createChatStreamControllerForRun')).toBe('createChatStreamControllerForRun')
    expect(speakIdentifier('src/main/voice/speechText.ts')).toBe('speechText')
  })

  it('turns headings and list items into sentences and strips emphasis, emoji and tags', () => {
    const md = '## Summary\n- **Fixed** the _flaky_ test 🎉\n- Added a retry [laughs]\n> Note this'
    expect(toSpeakable(md)).toBe('Summary. Fixed the flaky test. Added a retry. Note this.')
  })
})

describe('SentenceSplitter', () => {
  it('emits whole sentences as they complete and waits on an ambiguous end', () => {
    const s = new SentenceSplitter(Number.POSITIVE_INFINITY)
    expect(s.push('I fixed it. The tests')).toEqual(['I fixed it.'])
    expect(s.push(' pass now.')).toEqual([])
    expect(s.push(' Want more?')).toEqual(['The tests pass now.'])
    expect(s.flush()).toEqual(['Want more?'])
  })

  it('does not split on versions, file names or abbreviations', () => {
    const s = new SentenceSplitter(Number.POSITIVE_INFINITY)
    const out = s.push('Bumped to 1.2.0 in loop.ts, e.g. the retry path. Done ')
    expect(out).toEqual(['Bumped to 1.2.0 in loop.ts, e.g. the retry path.'])
    expect(s.flush()).toEqual(['Done'])
  })

  it('cuts the first piece early at a comma once it is long enough, never later ones', () => {
    const s = new SentenceSplitter(20)
    expect(s.push('The race in the follow-up queue, which only showed on Windows, ')).toEqual([
      'The race in the follow-up queue,'
    ])
    expect(s.push('is fixed, and the tests, all of them, pass ')).toEqual([])
    expect(s.flush()).toEqual(['which only showed on Windows, is fixed, and the tests, all of them, pass'])
  })
})

describe('fallbackSummary', () => {
  it('speaks the first sentences and points at the screen when it left things out', () => {
    const answer =
      'I fixed the race. The queue now locks. Tests pass. I also cleaned up two helpers.\n\n```ts\nx\n```'
    expect(fallbackSummary(answer)).toBe(`I fixed the race. The queue now locks. Tests pass. ${DETAILS_ON_SCREEN}`)
  })

  it('speaks a short complete answer as is', () => {
    expect(fallbackSummary('All green.')).toBe('All green.')
  })

  it('returns nothing for an empty answer', () => {
    expect(fallbackSummary('   ')).toBe('')
  })
})

describe('isStopPhrase', () => {
  it('matches the whole utterance only', () => {
    expect(isStopPhrase('Stop!')).toBe(true)
    expect(isStopPhrase('  never mind. ')).toBe(true)
    expect(isStopPhrase('stop the timer from firing twice')).toBe(false)
    expect(isStopPhrase('cancelled orders are wrong')).toBe(false)
  })
})
