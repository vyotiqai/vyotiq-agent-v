import { useEffect, useSyncExternalStore } from 'react'
import type { VoiceConversationSummary } from '@shared/ipc/schemas/voiceConversations'

/*
  Each workspace's kept voice conversations, read once and shared by every
  brief that asks whether it was said by voice (docs/voice-mode.md §24.8).
  Read again when the history dialog opens, and when a live session hands
  work to a run (VoiceConversationsDialog watches for that) — the log lands
  on disk within a quarter second of the hand-off, so the read waits a
  little longer.
*/

type Entry = { list: VoiceConversationSummary[] | null; loading: boolean }

const byWorkspace = new Map<string, Entry>()
const listeners = new Set<() => void>()
/** After a hand-off, past the writer's 250 ms batch. */
export const AFTER_HAND_OFF_MS = 600

function emit(): void {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function loadVoiceConversations(workspacePath: string): Promise<VoiceConversationSummary[] | null> {
  const prev = byWorkspace.get(workspacePath)
  byWorkspace.set(workspacePath, { list: prev?.list ?? null, loading: true })
  let res: Awaited<ReturnType<typeof window.vyotiq.voiceConversationsList>> | null = null
  try {
    res = await window.vyotiq.voiceConversationsList({ workspacePath })
  } catch {
    // A bridge without the call (an older preload, a test stub) has no conversations to show.
  }
  const list = res?.ok ? res.data : (prev?.list ?? [])
  byWorkspace.set(workspacePath, { list, loading: false })
  emit()
  return list
}

function ensure(workspacePath: string): void {
  if (!byWorkspace.has(workspacePath)) void loadVoiceConversations(workspacePath)
}

/** Read every list already read again: a live session handed work to a run they may not name yet. */
export function reloadVoiceConversations(): void {
  for (const path of byWorkspace.keys()) void loadVoiceConversations(path)
}

const EMPTY: readonly VoiceConversationSummary[] = []

/** A workspace's kept conversations, newest first; empty until read. */
export function useVoiceConversations(workspacePath: string | null | undefined): readonly VoiceConversationSummary[] {
  useEffect(() => {
    if (workspacePath) ensure(workspacePath)
  }, [workspacePath])
  return useSyncExternalStore(
    subscribe,
    () => (workspacePath ? (byWorkspace.get(workspacePath)?.list ?? EMPTY) : EMPTY),
    () => EMPTY
  )
}

/** Where a brief came from, when it was said by voice. */
export type VoiceOrigin = { conversationId: string; turns: number }

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Which conversation a task's instruction came from: the one whose hand-off
 * to this run carried these words. A task holds typed and spoken
 * instructions side by side, so only the words decide which is which. A new
 * task starts from anything typed in its brief, then the spoken words: those
 * end the instruction.
 */
export function voiceOriginFor(
  list: readonly VoiceConversationSummary[],
  runId: string | null | undefined,
  text: string
): VoiceOrigin | null {
  const words = squash(text)
  if (!runId || !words) return null
  for (const c of list) {
    const said = c.sent.some((s) => {
      const brief = squash(s.brief)
      return s.runId === runId && brief !== '' && words.endsWith(brief)
    })
    if (said) return { conversationId: c.id, turns: c.turns }
  }
  return null
}

/** Tests only. */
export function resetVoiceConversationStoreForTests(): void {
  byWorkspace.clear()
}
