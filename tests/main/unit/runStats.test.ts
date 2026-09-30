import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { readLenientReceiptCost } from '@main/agent/runStats'
import { resetJsonDocCacheForTests } from '@main/agent/jsonDocCache'

const root = mkdtempSync(join(tmpdir(), `vyotiq-runstats-${process.pid}-`))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  resetJsonDocCacheForTests()
})

function makeRun(id: string, receipt?: string): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  if (receipt !== undefined) writeFileSync(join(dir, 'receipt.json'), receipt)
  return dir
}

describe('readLenientReceiptCost', () => {
  it('reads billed and estimated cost from a partial receipt', async () => {
    const dir = makeRun('run-1', JSON.stringify({ billedCost: 1.25, estimatedCost: 0.5 }))
    expect(await readLenientReceiptCost(dir)).toEqual({ billedCost: 1.25, estimatedCost: 0.5 })
  })

  it('drops zero and non-numeric costs', async () => {
    const dir = makeRun('run-2', JSON.stringify({ billedCost: 0, estimatedCost: 'x' }))
    expect(await readLenientReceiptCost(dir)).toBeUndefined()
  })

  it('returns undefined for a missing or corrupt receipt', async () => {
    expect(await readLenientReceiptCost(makeRun('run-3'))).toBeUndefined()
    expect(await readLenientReceiptCost(makeRun('run-4', '{not json'))).toBeUndefined()
  })
})
