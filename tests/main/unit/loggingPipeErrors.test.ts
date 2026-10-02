import { describe, expect, it } from 'vitest'
import { abortError } from '@shared/errors'
import {
  isIgnorablePipeError,
  isIgnorableUncaught,
  isRefusedNodePtyFork
} from '@main/logging/pipeErrors'

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

describe('isRefusedNodePtyFork', () => {
  const refusal =
    'child_process.fork() is not supported when the runAsNode fuse is disabled; use utilityProcess.fork() instead'
  const withStack = (message: string, stack: string): Error =>
    Object.assign(new Error(message), { stack })

  it('ignores the refusal when node-pty forked', () => {
    const err = withStack(
      refusal,
      'Error: x\n    at WindowsPtyAgent._getConsoleProcessList (C:\\app\\node_modules\\node-pty\\lib\\windowsPtyAgent.js:184:41)'
    )
    expect(isRefusedNodePtyFork(err)).toBe(true)
    expect(isIgnorableUncaught(err)).toBe(true)
  })

  it('still treats any other refused fork as fatal', () => {
    const err = withStack(refusal, 'Error: x\n    at run (C:\\app\\out\\main\\index.js:1:1)')
    expect(isRefusedNodePtyFork(err)).toBe(false)
    expect(isIgnorableUncaught(err)).toBe(false)
    expect(isRefusedNodePtyFork(withStack('boom', 'at node-pty/lib/x.js'))).toBe(false)
    expect(isRefusedNodePtyFork(refusal)).toBe(false)
  })
})
