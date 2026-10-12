import { describe, expect, it } from 'vitest'
import { railInitials, railLabels } from '@renderer/app/navigator/NavigatorRail'

describe('railInitials', () => {
  it('takes the first letters of the first two words that carry meaning', () => {
    expect(railInitials('Hey What can we do?')).toBe('HW')
    expect(railInitials('Update the docs')).toBe('UD')
    expect(railInitials('Fix a flaky test')).toBe('FF')
  })

  it('keeps a leading filler word, since it is the only start the title has', () => {
    expect(railInitials('The parser fails on CRLF')).toBe('TP')
  })

  it('gives one initial for one word and skips punctuation and symbols', () => {
    expect(railInitials('refactor')).toBe('R')
    expect(railInitials('"quoted" — (paren) title')).toBe('QP')
    expect(railInitials('/review 42')).toBe('R4')
  })

  it('reads letters beyond ASCII and gives nothing for a title without any', () => {
    expect(railInitials('élan vital')).toBe('ÉV')
    expect(railInitials('—')).toBe('')
    expect(railInitials('')).toBe('')
  })
})

describe('railLabels', () => {
  it('keeps initials that are already unique', () => {
    expect(railLabels(['Update the docs', 'Fix a flaky test'])).toEqual(['UD', 'FF'])
  })

  it('tells apart two tasks with the same initials', () => {
    const labels = railLabels(['Tidy the tests', 'Tune timeouts', 'Ship it'])
    expect(labels).toEqual(['Ti', 'Tu', 'SI'])
    expect(new Set(labels).size).toBe(3)
  })

  it('goes further in when the first two letters match too', () => {
    const labels = railLabels(['Test the parser', 'Test the printer'])
    expect(new Set(labels).size).toBe(2)
    for (const label of labels) expect(label.length).toBe(2)
  })
})
