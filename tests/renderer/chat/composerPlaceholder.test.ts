import { describe, expect, it } from 'vitest'
import { resolveComposerPlaceholder } from '@renderer/features/chat/components/composer/composerPlaceholder'

describe('resolveComposerPlaceholder', () => {
  const base = {
    hasWorkspace: true,
    running: false,
    agentMode: 'agent' as const,
    hasTranscript: false
  }

  it('prefers a non-empty override', () => {
    expect(
      resolveComposerPlaceholder({
        ...base,
        hasWorkspace: false,
        override: 'Edit message…'
      })
    ).toBe('Edit message…')
  })

  it('ignores blank override', () => {
    expect(resolveComposerPlaceholder({ ...base, override: '  ' })).toBe(
      'Describe a task · @ to attach · / for commands'
    )
  })

  it('gates on workspace', () => {
    expect(resolveComposerPlaceholder({ ...base, hasWorkspace: false })).toBe(
      'Open a workspace to start chatting'
    )
  })

  it('uses mid-run follow-up copy while running', () => {
    expect(resolveComposerPlaceholder({ ...base, running: true })).toBe(
      'Queue a follow-up…'
    )
  })

  it('covers Ask empty and follow-up', () => {
    expect(resolveComposerPlaceholder({ ...base, agentMode: 'ask' })).toBe(
      'Ask a question · won’t edit files · @ to attach · / for commands'
    )
    expect(
      resolveComposerPlaceholder({ ...base, agentMode: 'ask', hasTranscript: true })
    ).toBe('Ask a follow-up · won’t edit files')
  })

  it('falls back to the Agent placeholder for a legacy plan mode', () => {
    expect(
      // @ts-expect-error legacy persisted value: Plan was merged into Agent.
      resolveComposerPlaceholder({ ...base, agentMode: 'plan' })
    ).toBe('Describe a task · @ to attach · / for commands')
  })

  it('covers Agent empty and follow-up', () => {
    expect(resolveComposerPlaceholder(base)).toBe(
      'Describe a task · @ to attach · / for commands'
    )
    expect(resolveComposerPlaceholder({ ...base, hasTranscript: true })).toBe(
      'Send a follow-up'
    )
  })

  it('running takes precedence over mode/transcript', () => {
    expect(
      resolveComposerPlaceholder({
        ...base,
        running: true,
        agentMode: 'ask',
        hasTranscript: true
      })
    ).toBe('Queue a follow-up…')
  })

  it('workspace gate beats running', () => {
    expect(
      resolveComposerPlaceholder({
        ...base,
        hasWorkspace: false,
        running: true
      })
    ).toBe('Open a workspace to start chatting')
  })
})
