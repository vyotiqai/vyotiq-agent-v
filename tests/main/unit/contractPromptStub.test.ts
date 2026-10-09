import { describe, expect, it } from 'vitest'
import { withoutDefaultDoneWhen } from '@main/agent/context/assemble'
import { contractDoneWhenBlock, defaultDoneWhenBlock } from '@shared/doneWhenChecks'

describe('run contract in the prompt', () => {
  it('leaves out createRun’s Done when stub, which said nothing the harness doesn’t', () => {
    const contract = ['## Goal', '', 'Fix add() in math.js', '', defaultDoneWhenBlock(), ''].join('\n')
    expect(withoutDefaultDoneWhen(contract)).toBe('## Goal\n\nFix add() in math.js')
    expect(withoutDefaultDoneWhen(contract.replace(/\n/g, '\r\n'))).toBe('## Goal\n\nFix add() in math.js')
  })

  it('keeps a Done when the brief or the plan wrote', () => {
    const block = contractDoneWhenBlock([
      { id: 'c1', text: '`pnpm test` passes', source: 'brief', verdict: null, createdAt: '2026-10-09T00:00:00.000Z' }
    ])
    const contract = ['## Goal', '', 'Fix add()', '', block].join('\n')
    expect(withoutDefaultDoneWhen(contract)).toBe(contract)
  })
})
