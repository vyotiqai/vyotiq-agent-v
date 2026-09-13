import { afterEach, describe, expect, it } from 'vitest'
import { isChatFixtureReplayEnabled } from '@main/e2e/chatFixtureReplay'

describe('isChatFixtureReplayEnabled', () => {
  const prev = process.env.VYOTIQ_E2E_FIXTURE

  afterEach(() => {
    if (prev === undefined) {
      delete process.env.VYOTIQ_E2E_FIXTURE
    } else {
      process.env.VYOTIQ_E2E_FIXTURE = prev
    }
  })

  it('is disabled under vitest even when VYOTIQ_E2E_FIXTURE=1', () => {
    process.env.VYOTIQ_E2E_FIXTURE = '1'
    expect(isChatFixtureReplayEnabled()).toBe(false)
  })
})
