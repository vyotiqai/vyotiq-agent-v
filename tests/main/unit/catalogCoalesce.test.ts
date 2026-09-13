import { describe, expect, it } from 'vitest'
import { awaitCatalogWithCallerSignal } from '@main/agent/providers'

describe('awaitCatalogWithCallerSignal', () => {
  it('does not cancel a shared catalog fetch when one caller aborts', async () => {
    let resolveRun!: (value: string) => void
    const run = new Promise<string>((resolve) => {
      resolveRun = resolve
    })
    const first = new AbortController()
    const waiting = awaitCatalogWithCallerSignal(run, first.signal)
    const joined = awaitCatalogWithCallerSignal(run)
    first.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    resolveRun('catalog')
    await expect(joined).resolves.toBe('catalog')
  })
})
