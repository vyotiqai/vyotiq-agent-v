import { describe, expect, it } from 'vitest'
import {
  bumpFailure,
  formatAppendFailure,
  isTransientFsError,
  withTransientAppendRetry,
  type DirAppendFailures
} from '@main/agent/appendRetry'

function errnoError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

describe('isTransientFsError', () => {
  it('recognizes transient codes', () => {
    for (const code of ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'EDEADLK', 'ETIMEDOUT']) {
      expect(isTransientFsError(errnoError(code))).toBe(true)
    }
  })

  it('rejects permanent codes, plain errors, and non-errors', () => {
    expect(isTransientFsError(errnoError('ENOSPC'))).toBe(false)
    expect(isTransientFsError(errnoError('EACCES'))).toBe(false)
    expect(isTransientFsError(new Error('no code here'))).toBe(false)
    expect(isTransientFsError('EBUSY')).toBe(false)
    expect(isTransientFsError(null)).toBe(false)
  })
})

describe('withTransientAppendRetry', () => {
  it('retries transient failures and then succeeds', async () => {
    let calls = 0
    const out = await withTransientAppendRetry(async () => {
      calls += 1
      if (calls < 3) throw errnoError('EBUSY')
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(calls).toBe(3)
  })

  it('propagates non-transient errors immediately', async () => {
    let calls = 0
    await expect(
      withTransientAppendRetry(async () => {
        calls += 1
        throw errnoError('ENOSPC')
      })
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(calls).toBe(1)
  })

  it('throws after exhausting attempts on persistent transient errors', async () => {
    let calls = 0
    await expect(
      withTransientAppendRetry(
        async () => {
          calls += 1
          throw errnoError('EMFILE')
        },
        2
      )
    ).rejects.toMatchObject({ code: 'EMFILE' })
    expect(calls).toBe(2)
  })

  it('does not retry when attempts is 1', async () => {
    let calls = 0
    await expect(
      withTransientAppendRetry(
        async () => {
          calls += 1
          throw errnoError('EBUSY')
        },
        1
      )
    ).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(1)
  })
})

describe('bumpFailure', () => {
  it('creates, accumulates, and refreshes per-dir failures', () => {
    const map = new Map<string, DirAppendFailures>()
    const first = new Error('first')
    bumpFailure(map, 'run-a', first)
    expect(map.get('run-a')).toEqual({ count: 1, last: first })

    const second = new Error('second')
    bumpFailure(map, 'run-a', second)
    expect(map.get('run-a')).toEqual({ count: 2, last: second })

    bumpFailure(map, 'run-b', 'stringy failure')
    expect(map.get('run-b')?.count).toBe(1)
    expect(map.get('run-b')?.last).toBeInstanceOf(Error)
    expect(map.get('run-b')?.last.message).toBe('stringy failure')
  })
})

describe('formatAppendFailure', () => {
  it('uses the bare message for a single failure', () => {
    const err = formatAppendFailure('events.jsonl', [
      { count: 1, last: new Error('disk went away') }
    ])
    expect(err.message).toBe('disk went away')
    expect(err.cause).toBeInstanceOf(Error)
  })

  it('aggregates totals across runs', () => {
    const err = formatAppendFailure('messages.jsonl', [
      { count: 2, last: new Error('boom-a') },
      { count: 3, last: new Error('boom-b') }
    ])
    expect(err.message).toBe(
      '5 record(s) failed to persist to messages.jsonl across 2 run(s); last error: boom-b'
    )
    expect((err.cause as Error).message).toBe('boom-b')
  })
})
