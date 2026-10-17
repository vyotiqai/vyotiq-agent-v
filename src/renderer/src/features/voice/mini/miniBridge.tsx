import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { VoiceMiniCommand, VoiceMiniState } from '@shared/ipc/schemas/voiceMini'
import { useStage, type StageApi } from '../stage/kit'

/*
  The main window's half of the voice mini window (docs/voice-mode.md
  §26.5): it opens the window, mirrors the session into it, and carries out
  its clicks. The mic and the voice stay here (2026-10-15 decision), so the
  session never moves between windows. Without the window (an older main,
  or it couldn't open, or it was closed from the OS) the main window shows
  the session itself: `fallback`, the capsule.
*/

/** How often the orb's level goes to the mini window: smooth enough for a 32–112px orb, cheap over IPC. */
const LEVEL_MS = 50

/** The main window's `<html>` data attributes (skin, theme, font scale…), so the mini window looks the same. */
function appearance(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const attr of Array.from(document.documentElement.attributes)) {
    if (attr.name.startsWith('data-') && Object.keys(out).length < 24) out[attr.name] = attr.value.slice(0, 200)
  }
  return out
}

/** Carry out a click from the mini window on the session here. */
export function runMiniCommand(api: StageApi, cmd: VoiceMiniCommand): void {
  switch (cmd.kind) {
    case 'mute':
      return api.mute(cmd.muted)
    case 'hold':
      return api.hold(cmd.down)
    case 'stop_speaking':
      return api.stopSpeaking()
    case 'stop_task':
      return api.stopTask()
    case 'end':
      return api.end()
    case 'retry':
      return api.retry?.()
    case 'open_settings':
      return api.openVoiceSettings?.()
    case 'settings':
      return api.patchSettings(cmd.patch)
    case 'approval':
      void api.respondApproval(cmd.requestId, cmd.decision, cmd.runId)
      return
    case 'question':
      void api.respondQuestion(cmd.requestId, cmd.questionId, cmd.value, cmd.runId)
      return
    case 'form':
      void api.respondForm?.(cmd.requestId, cmd.answers, cmd.runId)
      return
    case 'closed':
    case 'ready':
      return
  }
}

export function MiniWindowBridge({ fallback }: { fallback: ReactNode }) {
  const api = useStage()
  const bridge = window.vyotiq
  const [shown, setShown] = useState<'opening' | 'open' | 'failed'>(bridge.voiceMiniOpen ? 'opening' : 'failed')
  // The latest session, for the command handler and the level loop (set once).
  const latest = useRef(api)
  latest.current = api

  // Open on mount, close on unmount (End, or another placement picked).
  useEffect(() => {
    if (!bridge.voiceMiniOpen) return
    let live = true
    void bridge.voiceMiniOpen({ open: true }).then(
      (res) => {
        if (live) setShown(res?.ok ? 'open' : 'failed')
      },
      () => {
        if (live) setShown('failed')
      }
    )
    return () => {
      live = false
      void bridge.voiceMiniOpen?.({ open: false })
    }
  }, [bridge])

  // Its clicks, carried out here.
  useEffect(() => {
    return bridge.onVoiceMiniCommand?.((cmd) => {
      if (cmd.kind === 'closed') setShown('failed')
      else runMiniCommand(latest.current, cmd)
    })
  }, [bridge])

  // The session as it should draw it, whenever it changes.
  useEffect(() => {
    if (shown !== 'open') return
    const state: VoiceMiniState = {
      snapshot: api.v as unknown as Record<string, unknown>,
      settings: api.settings as unknown as Record<string, unknown>,
      startedAt: api.startedAt,
      escArmed: api.escArmed,
      appearance: appearance()
    }
    bridge.voiceMiniPush?.(state)
  }, [shown, api.v, api.settings, api.startedAt, api.escArmed, bridge])

  // A skin or theme change reaches it too.
  useEffect(() => {
    if (shown !== 'open') return
    const mo = new MutationObserver(() => {
      const a = latest.current
      bridge.voiceMiniPush?.({
        snapshot: a.v as unknown as Record<string, unknown>,
        settings: a.settings as unknown as Record<string, unknown>,
        startedAt: a.startedAt,
        escArmed: a.escArmed,
        appearance: appearance()
      })
    })
    mo.observe(document.documentElement, { attributes: true })
    return () => mo.disconnect()
  }, [shown, bridge])

  // The orb's level, while it is open.
  useEffect(() => {
    if (shown !== 'open' || !bridge.voiceMiniPushLevel) return
    const t = setInterval(() => {
      const a = latest.current
      bridge.voiceMiniPushLevel?.({ level: clamp01(a.level()), mic: clamp01(a.micLevel()) })
    }, LEVEL_MS)
    return () => clearInterval(t)
  }, [shown, bridge])

  return shown === 'failed' ? <>{fallback}</> : null
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}
