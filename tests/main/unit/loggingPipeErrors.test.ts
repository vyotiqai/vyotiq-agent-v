import { describe, expect, it } from 'vitest'
import { abortError } from '@shared/errors'
import { isIgnorablePipeError, isIgnorableUncaught } from '@main/logging/pipeErrors'

describe('isIgnorablePipeError', () => {
  it('ignores EPIPE and ECONNRESET', () => {
    expect(isIgnorablePipeError(Object.assign(new Error('write'), { code: 'EPIPE' }))).toBe(true)
    expect(isIgnorablePipeError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true
    )
  })

  it('does not ignore other errors', () => {
    expect(isIgnorablePipeError(new Error('boom'))).toBe(false)
    expect(isIgnorablePipeError(Object.assign(new Error('enoent'), { code: 'ENOENT' }))).toBe(
      false
    )
    expect(isIgnorablePipeError(null)).toBe(false)
    expect(isIgnorablePipeError('EPIPE')).toBe(false)
  })
})

describe('isIgnorableUncaught', () => {
  it('ignores pipe errors and abort-shaped errors', () => {
    expect(isIgnorableUncaught(Object.assign(new Error('write'), { code: 'EPIPE' }))).toBe(true)
    expect(isIgnorableUncaught(abortError())).toBe(true)
    expect(isIgnorableUncaught(new Error('Aborted'))).toBe(true)
  })

  it('does not ignore real crashes', () => {
    expect(isIgnorableUncaught(new Error('boom'))).toBe(false)
    expect(isIgnorableUncaught(null)).toBe(false)
  })
})
