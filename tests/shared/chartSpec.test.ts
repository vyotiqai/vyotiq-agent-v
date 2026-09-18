import { describe, expect, it } from 'vitest'
import {
  CHART_MAX_POINTS,
  CHART_MAX_SLICES,
  CHART_SPEC_MAX_CHARS,
  parseChartSpec
} from '@shared/chartSpec'

describe('parseChartSpec', () => {
  it('parses line and bar specs with titles, gaps, and matching lengths', () => {
    const line = parseChartSpec(
      '{"type":"line","title":"Spend","labels":["Mon","Tue","Wed"],"values":[1.2,null,3]}'
    )
    expect(line).toEqual({
      type: 'line',
      title: 'Spend',
      labels: ['Mon', 'Tue', 'Wed'],
      values: [1.2, null, 3]
    })
    expect(parseChartSpec('{"type":"bar","labels":["A"],"values":[0]}')).toEqual({
      type: 'bar',
      labels: ['A'],
      values: [0]
    })
  })

  it('parses donut and sparkline specs', () => {
    expect(parseChartSpec('{"type":"donut","labels":["A","B"],"values":[2,1]}')).toEqual({
      type: 'donut',
      labels: ['A', 'B'],
      values: [2, 1]
    })
    expect(parseChartSpec('{"type":"sparkline","values":[1,2,3]}')).toEqual({
      type: 'sparkline',
      values: [1, 2, 3]
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseChartSpec('\n  {"type":"sparkline","values":[1,2]}  \n')).toEqual({
      type: 'sparkline',
      values: [1, 2]
    })
  })

  it('rejects malformed JSON and empty bodies as plain-code fallbacks', () => {
    expect(parseChartSpec('{"type":"line",')).toBeNull()
    expect(parseChartSpec('')).toBeNull()
    expect(parseChartSpec('   ')).toBeNull()
    expect(parseChartSpec('42')).toBeNull()
    expect(parseChartSpec('{"type":"pie","labels":[],"values":[]}')).toBeNull()
  })

  it('rejects labels and values whose lengths disagree', () => {
    expect(
      parseChartSpec('{"type":"line","labels":["A","B"],"values":[1,2,3]}')
    ).toBeNull()
    expect(parseChartSpec('{"type":"donut","labels":["A","B"],"values":[1]}')).toBeNull()
  })

  it('enforces the hard caps a hostile reply cannot bypass', () => {
    const tooMany = Array.from({ length: CHART_MAX_POINTS + 1 }, (_, i) => i)
    expect(
      parseChartSpec(
        `{"type":"line","labels":${JSON.stringify(tooMany)},"values":${JSON.stringify(tooMany)}}`
      )
    ).toBeNull()

    const slices = Array.from({ length: CHART_MAX_SLICES + 1 }, (_, i) => i)
    expect(
      parseChartSpec(
        `{"type":"donut","labels":${JSON.stringify(slices)},"values":${JSON.stringify(slices)}}`
      )
    ).toBeNull()

    expect(
      parseChartSpec('{"type":"line","labels":["A"],"values":[-1]}')
    ).toBeNull()

    const huge = 'x'.repeat(CHART_SPEC_MAX_CHARS + 1)
    expect(parseChartSpec(huge)).toBeNull()
  })

  it('rejects a sparkline with a single point', () => {
    expect(parseChartSpec('{"type":"sparkline","values":[1]}')).toBeNull()
  })
})
