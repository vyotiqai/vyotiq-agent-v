import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DictationEngine, SecretProvider } from '@shared/ipc'
import { isEditableShortcutTarget, matchShortcut } from '@renderer/lib/shortcuts'
import { listMicDevices, openMicCapture, type MicCaptureFailure } from '@renderer/lib/audio/micCapture'
import {
  engineDetail,
  engineReady,
  fallbackEngine,
  getDictationState,
  localLiveDrafts,
  noteRuntimeStatus,
  patchDictationSettings,
  useDictationState
} from './dictationStore'
import { countWords, insertTranscriptAtCaret } from './insertText'
import {
  TakeController,
  idleSnapshot,
  joinWords,
  type TakeFinish,
  type TakeSnapshot
} from './takeController'

/*
  One composer's dictation: the take, what the field shows while it runs,
  what the words do when it ends, and the keys.

  Keys, all while this composer holds the take:
    Ctrl/Cmd M   tap: start, tap again to insert · hold: talk until released
    Enter        the setting's action (insert, or send)
    Ctrl Enter   the other one
    Esc          discard — Restore brings it back for a few seconds
    Ctrl Z       undo the insert, while "inserted" shows
*/

/** Held longer than this, the shortcut is push-to-talk. */
export const HOLD_MS = 300
/** "17 words inserted" and the tint on them stay this long. */
export const INSERTED_MS = 5000

export type TakeSurface = 'line' | 'brief' | 'inline'

/** What the mic button shows before it is pressed. */
export type MicState = 'idle' | 'setup' | 'live' | 'busy' | 'blocked'

export type TakeHighlight = {
  name: 'take-partial' | 'take-pending' | 'take-inserted'
  start: number
  end: number
}

/** What the strip shows: the take itself, or what happened just after it. */
export type TakeView =
  | { kind: 'take'; snap: TakeSnapshot }
  | { kind: 'inserted'; words: number }
  | { kind: 'mic_error'; failure: Exclude<MicCaptureFailure, 'blocked'>; message: string }
  | null

type Inserted = { words: number; prevText: string; prevCaret: number; text: string; start: number; end: number }

/** Only one take in the window at a time; its composer answers its keys. */
let activeOwner: object | null = null

/*
  Whisper on this PC loads before the mic is pressed when a take looks
  likely: the pointer on the mic, or the app opening for someone who
  dictated in the last day. Main unloads it again after a quiet spell, so
  a warm-up nobody used gives its memory back.
*/
const LAST_TAKE_KEY = 'vyotiq.dictation.lastLocalTakeAt'
/** Dictated on this PC this recently: load Whisper as the app opens. */
export const WARM_ON_OPEN_WITHIN_MS = 24 * 60 * 60 * 1000
/** After the app opens, wait this long so the load does not compete with startup. */
const WARM_ON_OPEN_DELAY_MS = 5000
/** One warm-up request per this long is plenty; main makes a repeat cheap anyway. */
const WARM_EVERY_MS = 60_000
let lastWarmAt = 0
let warmedOnOpen = false

function noteLocalTake(): void {
  try {
    localStorage.setItem(LAST_TAKE_KEY, String(Date.now()))
  } catch {
    /* a private window: no warm-up on open, nothing else changes */
  }
}

function dictatedRecently(): boolean {
  try {
    const at = Number(localStorage.getItem(LAST_TAKE_KEY))
    return Number.isFinite(at) && at > 0 && Date.now() - at < WARM_ON_OPEN_WITHIN_MS
  } catch {
    return false
  }
}

function warmLocal(force = false): void {
  const now = Date.now()
  if (!force && now - lastWarmAt < WARM_EVERY_MS) return
  lastWarmAt = now
  void window.vyotiq.dictationPrepare?.()
}

export function resetTakeWarmupForTests(): void {
  lastWarmAt = 0
  warmedOnOpen = false
}

export function useTake(opts: {
  surface: TakeSurface
  /** The open workspace, if any: its file names help cloud engines spell them. */
  workspacePath?: string | null
  text: string
  setText: (next: string) => void
  secrets: Record<SecretProvider, boolean>
  disabled?: boolean
  getCaret: () => number
  /** Put the caret here and focus the field. */
  setCaret: (offset: number) => void
  /** This composer is where the shortcut should act (focused, or the one in view). */
  isShortcutTarget: () => boolean
  focusComposer: () => void
  /** Submit once the inserted words are in the draft. Null where a take cannot send. */
  requestSend: (() => void) | null
  openSettings?: (section: 'voice' | 'providers') => void
}) {
  const { workspacePath, text, setText, secrets, disabled, getCaret, setCaret, isShortcutTarget, focusComposer, requestSend, openSettings } =
    opts
  const me = useRef({}).current
  const dictation = useDictationState()
  const [snap, setSnap] = useState<TakeSnapshot>(idleSnapshot)
  const [inserted, setInserted] = useState<Inserted | null>(null)
  const [micError, setMicError] = useState<{ failure: Exclude<MicCaptureFailure, 'blocked'>; message: string } | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [panel, setPanel] = useState<'setup' | 'blocked' | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  const textRef = useRef(text)
  textRef.current = text
  const baseRef = useRef<{ text: string; caret: number }>({ text: '', caret: 0 })
  const requestSendRef = useRef(requestSend)
  requestSendRef.current = requestSend
  const setTextRef = useRef(setText)
  setTextRef.current = setText
  const setCaretRef = useRef(setCaret)
  setCaretRef.current = setCaret
  const insertedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoStartAfterInstall = useRef(false)

  const controller = useMemo(
    () =>
      new TakeController({
        openCapture: openMicCapture,
        transcribe: (req) => window.vyotiq.transcribeDictation(req),
        cancel: (id) => void window.vyotiq.cancelDictation?.(id),
        // Whisper loads while the mic opens, not when the first words are due.
        prepare: (next) => {
          if (next !== 'local') return
          noteLocalTake()
          warmLocal(true)
        },
        onChange: (next) => {
          setSnap(next)
          if (next.phase === 'idle' && activeOwner === me) activeOwner = null
        },
        onDone: (words, reason) => land(words, reason),
        onStats: (stats) => void window.vyotiq.dictationTakeStats?.(stats),
        live: window.vyotiq.dictationLiveOpen
          ? {
              open: (req) => window.vyotiq.dictationLiveOpen(req),
              audio: (takeId, pcm16k) => void window.vyotiq.dictationLiveAudio({ takeId, pcm16k }),
              commit: (takeId) => void window.vyotiq.dictationLiveCommit(takeId),
              close: (takeId) => void window.vyotiq.dictationLiveClose(takeId),
              subscribe: (handler) => window.vyotiq.onDictationLiveEvent(handler)
            }
          : undefined,
        onMicFailure: (kind, message) => {
          if (activeOwner === me) activeOwner = null
          if (kind === 'blocked') {
            setBlocked(true)
            setPanel('blocked')
            return
          }
          setMicError({ failure: kind, message })
        }
      }),
    // `land` reads refs only; the controller lives as long as the composer.
    []
  )

  useEffect(
    () => () => {
      controller.dispose()
      if (activeOwner === me) activeOwner = null
      if (insertedTimer.current) clearTimeout(insertedTimer.current)
    },
    [controller, me]
  )

  const clearInserted = useCallback(() => {
    if (insertedTimer.current) clearTimeout(insertedTimer.current)
    insertedTimer.current = null
    setInserted(null)
    if (activeOwner === me && controller.snapshot.phase === 'idle') activeOwner = null
  }, [controller, me])

  /** The take is done: its words go into the draft at the caret it started from. */
  function land(words: string, reason: TakeFinish): void {
    const base = baseRef.current
    const next = insertTranscriptAtCaret(base.text, words, base.caret)
    const send = reason === 'send' && requestSendRef.current
    if (send) requestSendRef.current?.()
    setTextRef.current(next.text)
    setCaretRef.current(next.caret)
    if (send) {
      if (activeOwner === me) activeOwner = null
      return
    }
    if (insertedTimer.current) clearTimeout(insertedTimer.current)
    setInserted({
      words: countWords(words),
      prevText: base.text,
      prevCaret: base.caret,
      text: next.text,
      start: next.start,
      end: next.caret
    })
    activeOwner = me
    insertedTimer.current = setTimeout(() => {
      insertedTimer.current = null
      setInserted(null)
      if (activeOwner === me && controller.snapshot.phase === 'idle') activeOwner = null
    }, INSERTED_MS)
  }

  // Typing after an insert ends its "inserted" moment; typing while a take is
  // discarded gives up the restore (it would land in a different draft).
  useEffect(() => {
    if (inserted && text !== inserted.text) clearInserted()
    if (controller.snapshot.phase === 'discarded' && text !== baseRef.current.text) controller.dispose()
  }, [text, inserted, clearInserted, controller])

  const engine = dictation.settings.engine
  const ready = engineReady(engine, secrets, dictation.runtime)
  const phase = snap.phase
  const capturing = phase === 'starting' || phase === 'listening'

  /** The pointer or focus is on the mic: a take is likely, load Whisper now. */
  const warm = useCallback(() => {
    if (disabled || engine !== 'local' || !ready) return
    const current = controller.snapshot.phase
    if (current !== 'idle' && current !== 'discarded') return
    warmLocal()
  }, [disabled, engine, ready, controller])

  // The app opened for someone who dictates on this PC: load it once, after startup.
  useEffect(() => {
    if (warmedOnOpen || disabled || engine !== 'local' || !ready || !dictatedRecently()) return
    // Every composer schedules one; the first to fire warms for all of them.
    const timer = setTimeout(() => {
      if (warmedOnOpen) return
      warmedOnOpen = true
      warmLocal()
    }, WARM_ON_OPEN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [disabled, engine, ready])

  const start = useCallback(
    async (hold = false): Promise<void> => {
      if (disabled) return
      if (activeOwner && activeOwner !== me) return
      const current = controller.snapshot.phase
      if (current !== 'idle' && current !== 'discarded') return
      const { settings, runtime } = getDictationState()
      if (!engineReady(settings.engine, secrets, runtime)) {
        setPanel('setup')
        return
      }
      if (current === 'discarded') controller.dispose()
      clearInserted()
      setMicError(null)
      setPanel(null)
      baseRef.current = { text: textRef.current, caret: getCaret() }
      activeOwner = me
      const ok = await controller.start({
        engine: settings.engine,
        deviceId: settings.deviceId,
        language: settings.engine === 'local' ? undefined : settings.language,
        workspacePath: workspacePath || undefined,
        live: settings.engine === 'openai' && settings.liveWords,
        drafts: settings.engine !== 'local' || localLiveDrafts(settings, runtime)
      })
      if (ok) {
        setBlocked(false)
        if (hold) controller.setHold(true)
      }
    },
    [disabled, controller, me, secrets, getCaret, clearInserted, workspacePath]
  )

  const finish = useCallback(
    (reason: TakeFinish) => {
      controller.setHold(false)
      controller.finish(reason)
    },
    [controller]
  )

  /** The mic button. */
  const press = useCallback(() => {
    if (panel) {
      setPanel(null)
      return
    }
    if (blocked) {
      setPanel('blocked')
      return
    }
    if (capturing) {
      finish('insert')
      return
    }
    void start()
  }, [panel, blocked, capturing, finish, start])

  const insert = useCallback(() => finish('insert'), [finish])
  const send = useCallback(() => finish(requestSendRef.current ? 'send' : 'insert'), [finish])
  const discard = useCallback(() => controller.discard(), [controller])
  const restore = useCallback(() => void controller.restore(), [controller])
  const retry = useCallback((engineOverride?: DictationEngine) => controller.retry(engineOverride), [controller])
  const keep = useCallback(() => controller.keep(), [controller])

  const undo = useCallback(() => {
    const ins = inserted
    if (!ins) return
    clearInserted()
    setText(ins.prevText)
    setCaret(ins.prevCaret)
  }, [inserted, clearInserted, setText, setCaret])

  const switchDevice = useCallback(
    (deviceId: string) => {
      void patchDictationSettings({ deviceId })
      setMicError(null)
      void controller.switchDevice(deviceId)
    },
    [controller]
  )

  // ── Setup panel ────────────────────────────────────────────────────────
  const installLocal = useCallback(async () => {
    const modelId = dictation.runtime?.recommendedModelId ?? 'whisper-small.en'
    setInstallError(null)
    autoStartAfterInstall.current = true
    await patchDictationSettings({ engine: 'local', localModelId: modelId })
    const res = await window.vyotiq.dictationInstall({ modelId })
    if (!res.ok) {
      autoStartAfterInstall.current = false
      setInstallError(res.error || 'The download failed')
      return
    }
    noteRuntimeStatus(res.data)
  }, [dictation.runtime?.recommendedModelId])

  // The mic opens by itself once the model it was waiting for is on disk.
  useEffect(() => {
    if (!autoStartAfterInstall.current) return
    if (engine !== 'local' || (dictation.runtime?.installed.length ?? 0) === 0) return
    autoStartAfterInstall.current = false
    setPanel(null)
    void start()
  }, [engine, dictation.runtime, start])

  const useEngine = useCallback(
    async (next: DictationEngine) => {
      await patchDictationSettings({ engine: next })
      setPanel(null)
      if (engineReady(next, secrets, dictation.runtime)) void start()
    },
    [secrets, dictation.runtime, start]
  )

  // ── Keys ───────────────────────────────────────────────────────────────
  const snapRef = useRef(snap)
  snapRef.current = snap
  const insertedRef = useRef(inserted)
  insertedRef.current = inserted
  const holdToTalk = dictation.settings.holdToTalk
  const enterAction = dictation.settings.enterAction
  const pressRef = useRef({ start, finish, press, discard, undo, holdToTalk, enterAction })
  pressRef.current = { start, finish, press, discard, undo, holdToTalk, enterAction }

  useEffect(() => {
    if (disabled) return
    let downAt = 0
    let holdTimer: ReturnType<typeof setTimeout> | null = null
    let startedByKey = false

    const owns = (): boolean => activeOwner === me
    const target = (e: KeyboardEvent): boolean => {
      if (owns()) return true
      if (activeOwner) return false
      if (isShortcutTarget()) return true
      if (isEditableShortcutTarget(e.target)) return false
      focusComposer()
      return isShortcutTarget()
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const p = pressRef.current
      const phaseNow = snapRef.current.phase
      if (matchShortcut(e, 'dictation')) {
        if (e.repeat) {
          e.preventDefault()
          return
        }
        if (!target(e)) return
        e.preventDefault()
        e.stopPropagation()
        if (phaseNow === 'listening' || phaseNow === 'starting') {
          p.finish('insert')
          return
        }
        if (phaseNow !== 'idle' && phaseNow !== 'discarded') return
        downAt = Date.now()
        startedByKey = true
        void p.start()
        if (p.holdToTalk) {
          holdTimer = setTimeout(() => {
            holdTimer = null
            if (startedByKey) controller.setHold(true)
          }, HOLD_MS)
        }
        return
      }
      if (!owns()) return
      const mod = e.ctrlKey || e.metaKey
      const open = phaseNow === 'listening' || phaseNow === 'starting'
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing && open) {
        e.preventDefault()
        e.stopPropagation()
        const primary = p.enterAction === 'send' ? 'send' : 'insert'
        const other = primary === 'send' ? 'insert' : 'send'
        const want = mod ? other : primary
        p.finish(want === 'send' && requestSendRef.current ? 'send' : 'insert')
        return
      }
      if (e.key === 'Escape' && !mod && !e.altKey && (open || phaseNow === 'finishing' || phaseNow === 'failed')) {
        e.preventDefault()
        e.stopPropagation()
        p.discard()
        return
      }
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && insertedRef.current) {
        e.preventDefault()
        e.stopPropagation()
        p.undo()
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (!startedByKey) return
      const k = e.key.toLowerCase()
      if (k !== 'm' && k !== 'control' && k !== 'meta') return
      startedByKey = false
      if (holdTimer) {
        clearTimeout(holdTimer)
        holdTimer = null
      }
      // Released after the hold threshold: push-to-talk ends and inserts.
      if (pressRef.current.holdToTalk && Date.now() - downAt >= HOLD_MS && owns()) {
        pressRef.current.finish('insert')
      }
    }

    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== 'dictation') return
      if (!owns() && (activeOwner || !isShortcutTarget())) return
      pressRef.current.press()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('vyotiq:command', onCommand)
    return () => {
      if (holdTimer) clearTimeout(holdTimer)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('vyotiq:command', onCommand)
    }
  }, [disabled, me, controller, isShortcutTarget, focusComposer])

  // ── What the field shows ───────────────────────────────────────────────
  const field = useMemo((): { value: string | null; highlights: TakeHighlight[]; locked: boolean } => {
    const showsWords = phase === 'starting' || phase === 'listening' || phase === 'finishing' || phase === 'failed'
    if (showsWords) {
      const base = baseRef.current
      const marker = snap.pending ? '…' : ''
      const live = [joinWords([snap.settled, snap.partial]), marker].filter(Boolean).join(' ')
      const next = insertTranscriptAtCaret(base.text, live, base.caret)
      const highlights: TakeHighlight[] = []
      let at = next.start + (snap.settled ? snap.settled.length + 1 : 0)
      if (snap.partial) {
        highlights.push({ name: 'take-partial', start: at, end: at + snap.partial.length })
        at += snap.partial.length + 1
      }
      if (marker) highlights.push({ name: 'take-pending', start: next.caret - 1, end: next.caret })
      return { value: live ? next.text : base.text, highlights, locked: true }
    }
    if (inserted) {
      return { value: null, highlights: [{ name: 'take-inserted', start: inserted.start, end: inserted.end }], locked: false }
    }
    return { value: null, highlights: [], locked: false }
  }, [phase, snap.pending, snap.settled, snap.partial, inserted])

  const view: TakeView =
    phase !== 'idle'
      ? { kind: 'take', snap }
      : inserted
        ? { kind: 'inserted', words: inserted.words }
        : micError
          ? { kind: 'mic_error', ...micError }
          : null

  const mic: MicState = capturing
    ? 'live'
    : phase === 'finishing'
      ? 'busy'
      : blocked
        ? 'blocked'
        : !ready
          ? 'setup'
          : 'idle'

  return {
    view,
    snap,
    mic,
    field,
    panel,
    setPanel,
    installError,
    engineDetail: engineDetail(dictation.settings, dictation.runtime),
    runtime: dictation.runtime,
    engine,
    /** The microphone settings name ('' is the system default). */
    deviceId: dictation.settings.deviceId,
    enterAction,
    holdToTalk,
    secrets,
    fallback: phase === 'failed' ? fallbackEngine(snap.engine, secrets, dictation.runtime) : null,
    actions: {
      press,
      warm,
      insert,
      send,
      discard,
      restore,
      retry,
      keep,
      undo,
      switchDevice,
      dismissMicError: () => setMicError(null),
      installLocal,
      useEngine,
      tryAgain: () => {
        setBlocked(false)
        setPanel(null)
        void start()
      },
      openMicSettings: () => void window.vyotiq.dictationOpenMicSettings?.(),
      openSettings: (section: 'voice' | 'providers') => {
        setPanel(null)
        openSettings?.(section)
      },
      listDevices: listMicDevices
    }
  }
}

export type TakeHandle = ReturnType<typeof useTake>
