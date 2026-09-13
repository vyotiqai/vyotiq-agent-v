/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HOT_COMPOSER_DRAFT_KEY,
  getWorkspaceHotUi,
  resolveHotComposerDraft,
  resetWorkspaceHotUiStoreForTests,
  seedWorkspaceHotUi,
  setWorkspaceHotComposerDraft,
  setWorkspaceHotUi
} from '@renderer/lib/hooks/workspaceHotUiStore'

describe('workspaceHotUiStore composer drafts', () => {
  beforeEach(() => {
    resetWorkspaceHotUiStoreForTests()
  })

  it('stores per-run drafts without clobbering sibling runs', () => {
    setWorkspaceHotComposerDraft('/ws', 'run-a', 'draft-a')
    setWorkspaceHotComposerDraft('/ws', 'run-b', 'draft-b')
    setWorkspaceHotComposerDraft('/ws', null, 'new-chat')

    const hot = getWorkspaceHotUi('/ws')
    expect(resolveHotComposerDraft(hot, 'run-a')).toBe('draft-a')
    expect(resolveHotComposerDraft(hot, 'run-b')).toBe('draft-b')
    expect(resolveHotComposerDraft(hot, null)).toBe('new-chat')
    expect(hot.composerDraft).toBe('new-chat')
    expect(hot.composerDraftByRunId[HOT_COMPOSER_DRAFT_KEY]).toBe('new-chat')
  })

  it('updates run draft without rewriting legacy workspace composerDraft', () => {
    setWorkspaceHotComposerDraft('/ws', null, 'workspace-level')
    setWorkspaceHotComposerDraft('/ws', 'run-1', 'typed-on-run')

    const hot = getWorkspaceHotUi('/ws')
    expect(hot.composerDraft).toBe('workspace-level')
    expect(resolveHotComposerDraft(hot, 'run-1')).toBe('typed-on-run')
    expect(resolveHotComposerDraft(hot, null)).toBe('workspace-level')
  })

  it('keeps sessionQuery when writing composer drafts', () => {
    setWorkspaceHotUi('/ws', { sessionQuery: 'find me' })
    setWorkspaceHotComposerDraft('/ws', 'run-1', 'hello')
    expect(getWorkspaceHotUi('/ws').sessionQuery).toBe('find me')
  })

  it('seeds per-run map from persisted ui state', () => {
    seedWorkspaceHotUi('/ws', {
      composerDraft: 'legacy',
      composerDraftByRunId: { 'run-1': 'from-disk' },
      sessionQuery: ''
    })
    const hot = getWorkspaceHotUi('/ws')
    expect(resolveHotComposerDraft(hot, 'run-1')).toBe('from-disk')
    expect(resolveHotComposerDraft(hot, null)).toBe('legacy')
  })
})
