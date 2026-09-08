import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MAX_DICTATION_BYTES,
  MAX_DICTATION_MS,
  MAX_LOCAL_AUDIO_BYTES,
  MAX_LOCAL_DICTATION_MS,
  type DictationEngine,
  type DictationWaveformStyle,
  type SecretProvider
} from '@shared/ipc'
import { DICTATION_LOCAL_CATALOG, isQwen3AsrModelId, isQwen3AsrOnnxModelId } from '@shared/dictation'
import { blobToBase64, blobToPcm16kBase64 } from '@renderer/lib/audio/pcm16k'
import { isEditableShortcutTarget, matchShortcut } from '@renderer/lib/shortcuts'
import { prefersReducedMotion } from '@renderer/lib/utils/motion'
import {
  DICTATION_WAVEFORM_BARS,
  type DictationSettingsSection
} from './DictationSessionStrip'

export type DictationPhase = 'idle' | 'checking' | 'recording' | 'transcribing'

/** Auto-stop headroom so a final timeslice rarely exceeds the engine's byte limit. */
function sizeStopBytes(engine: DictationEngine): number {
  const cap =
    engine === 'local' || engine === 'qwen3-asr-onnx' ? MAX_LOCAL_AUDIO_BYTES : MAX_DICTATION_BYTES
  return cap - 256 * 1024
}

function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm'
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return ''
}

export function insertTranscriptAtCaret(
  prev: string,
  transcript: string,
  caret: number
): { text: string; caret: number } {
  const t = transcript.trim()
  if (!t) return { text: prev, caret }
  const clamped = Math.max(0, Math.min(caret, prev.length))
  const before = prev.slice(0, clamped)
  const after = prev.slice(clamped)
  const left = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const right = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  return {
    text: `${before}${left}${t}${right}${after}`,
    caret: before.length + left.length + t.length
  }
}

export function formatDictationEngineHint(
  engine: DictationEngine,
  localModelId: string
): string {
  switch (engine) {
    case 'openai':
      return 'OpenAI'
    case 'openrouter':
      return 'OpenRouter'
    case 'local': {
      const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === localModelId)
      return entry ? `Local · ${entry.label}` : 'Local'
    }
    case 'qwen3-asr':
    case 'qwen3-asr-onnx': {
      const entry = DICTATION_LOCAL_CATALOG.find((m) => m.id === localModelId)
      return entry ? `Qwen3-ASR · ${entry.label}` : 'Qwen3-ASR'
    }
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}

function classifyErrorAction(
  message: string,
  engine: DictationEngine
): DictationSettingsSection | null {
  if (/Providers/i.test(message) || /API key/i.test(message)) return 'providers'
  if (/Voice/i.test(message) || /Whisper/i.test(message)) return 'voice'
  switch (engine) {
    case 'openai':
    case 'openrouter':
      return null
    case 'local':
    case 'qwen3-asr':
    case 'qwen3-asr-onnx':
      return 'voice'
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}

type DictationContext = {
  engine: DictationEngine
  localModelId: string
  waveformStyle: DictationWaveformStyle
}

async function loadDictationContext(): Promise<DictationContext> {
  try {
    if (typeof window.vyotiq?.getSettings !== 'function') {
      return { engine: 'openai', localModelId: '', waveformStyle: 'bars' }
    }
    const res = await window.vyotiq.getSettings()
    if (res.ok && res.data.dictation) {
      return {
        engine: res.data.dictation.engine,
        localModelId: res.data.dictation.localModelId ?? '',
        waveformStyle: res.data.dictation.waveformStyle ?? 'bars'
      }
    }
  } catch {
    /* ignore */
  }
  return { engine: 'openai', localModelId: '', waveformStyle: 'bars' }
}

type PreflightResult =
  | { ok: true; ctx: DictationContext }
  | { ok: false; message: string; settingsSection: DictationSettingsSection | null }

async function preflightDictation(
  secrets: Record<SecretProvider, boolean>
): Promise<PreflightResult> {
  const ctx = await loadDictationContext()
  switch (ctx.engine) {
    case 'openai':
      if (!secrets.openai) {
        return {
          ok: false,
          message: 'Add an OpenAI API key',
          settingsSection: 'providers'
        }
      }
      return { ok: true, ctx }
    case 'openrouter':
      if (!secrets.openrouter) {
        return {
          ok: false,
          message: 'Add an OpenRouter API key',
          settingsSection: 'providers'
        }
      }
      return { ok: true, ctx }
    case 'local': {
      if (typeof window.vyotiq?.dictationStatus !== 'function') {
        return {
          ok: false,
          message: 'Install a local Whisper model',
          settingsSection: 'voice'
        }
      }
      try {
        const status = await window.vyotiq.dictationStatus()
        if (!status.ok || status.data.installed.length === 0) {
          return {
            ok: false,
            message: 'Install a local Whisper model',
            settingsSection: 'voice'
          }
        }
      } catch {
        return {
          ok: false,
          message: 'Install a local Whisper model',
          settingsSection: 'voice'
        }
      }
      return { ok: true, ctx }
    }
    case 'qwen3-asr': {
      if (!isQwen3AsrModelId(ctx.localModelId)) {
        return {
          ok: false,
          message: 'Select a Qwen3-ASR model in Settings → Voice',
          settingsSection: 'voice'
        }
      }
      return { ok: true, ctx }
    }
    case 'qwen3-asr-onnx': {
      if (!isQwen3AsrOnnxModelId(ctx.localModelId)) {
        return {
          ok: false,
          message: 'Install a Qwen3-ASR (on-device) model in Settings → Voice',
          settingsSection: 'voice'
        }
      }
      return { ok: true, ctx }
    }
    default: {
      const _exhaustive: never = ctx.engine
      return _exhaustive
    }
  }
}

function quietWaveform(): number[] {
  return Array.from({ length: DICTATION_WAVEFORM_BARS }, () => 0.12)
}

/** Peak amplitude per bar from a time-domain analyser frame — full-width live waveform. */
function barsFromTimeDomain(data: Uint8Array, barCount: number): number[] {
  const out = new Array<number>(barCount)
  if (data.length === 0 || barCount <= 0) return quietWaveform()
  const slice = Math.max(1, Math.floor(data.length / barCount))
  for (let i = 0; i < barCount; i++) {
    const start = i * slice
    let peak = 0
    for (let j = 0; j < slice; j++) {
      const n = Math.abs(((data[start + j] ?? 128) - 128) / 128)
      if (n > peak) peak = n
    }
    out[i] = Math.max(0.08, Math.min(1, peak * 2.4))
  }
  return out
}

export function useComposerDictation(opts: {
  text: string
  setText: (next: string) => void
  secrets: Record<SecretProvider, boolean>
  disabled?: boolean
  /** When true, Ctrl/Cmd+M is handled. */
  shortcutActive?: boolean
  /** Narrow multi-pane: only the focused composer reacts. */
  isShortcutTarget?: () => boolean
  /** Focus the composer before toggling when the shortcut fires away from it. */
  focusComposer?: () => void
  getCaret?: () => number
  setCaret?: (offset: number) => void
}) {
  const {
    text,
    setText,
    secrets,
    disabled,
    shortcutActive,
    isShortcutTarget,
    focusComposer,
    getCaret,
    setCaret
  } = opts
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorAction, setErrorAction] = useState<DictationSettingsSection | null>(null)
  const [waveform, setWaveform] = useState<number[]>(quietWaveform)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [engineHint, setEngineHint] = useState('OpenAI')
  const [waveformStyle, setWaveformStyle] = useState<DictationWaveformStyle>('bars')

  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const textRef = useRef(text)
  textRef.current = text
  const secretsRef = useRef(secrets)
  secretsRef.current = secrets
  const caretAtStartRef = useRef(0)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  /** Running total of chunk bytes; used to auto-stop before OpenAI 25 MB. */
  const bytesRef = useRef(0)
  const mimeRef = useRef('audio/webm')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startingRef = useRef(false)
  const finishRef = useRef<() => void>(() => undefined)
  const sessionGenRef = useRef(0)
  const activeGenRef = useRef(0)
  const startedAtRef = useRef(0)
  const analyserCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analyserBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const engineRef = useRef<DictationEngine>('openai')
  const transcriptionIdRef = useRef<string | null>(null)

  const publishError = useCallback(
    (message: string, action: DictationSettingsSection | null = null) => {
      setError(message)
      setErrorAction(action)
    },
    []
  )

  const clearError = useCallback(() => {
    setError(null)
    setErrorAction(null)
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const stopMeter = useCallback(() => {
    if (tickRef.current != null) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
    const ctx = analyserCtxRef.current
    analyserCtxRef.current = null
    analyserRef.current = null
    analyserBufRef.current = null
    if (ctx) void ctx.close().catch(() => undefined)
  }, [])

  const stopTracks = useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
    }
  }, [])

  const teardownCapture = useCallback(() => {
    clearTimer()
    stopMeter()
    startingRef.current = false
    const recorder = recorderRef.current
    recorderRef.current = null
    chunksRef.current = []
    bytesRef.current = 0
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.onerror = null
        recorder.stop()
      } catch {
        // ignore
      }
    }
    stopTracks()
  }, [clearTimer, stopMeter, stopTracks])

  const startMeter = useCallback((stream: MediaStream) => {
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setWaveform(quietWaveform())
    const reducedMotion = prefersReducedMotion()
    try {
      if (reducedMotion || typeof AudioContext === 'undefined') throw new Error('no audio')
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.55
      source.connect(analyser)
      analyserCtxRef.current = ctx
      analyserRef.current = analyser
      analyserBufRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    } catch {
      analyserCtxRef.current = null
      analyserRef.current = null
      analyserBufRef.current = null
    }
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
      if (reducedMotion) return
      const analyser = analyserRef.current
      const buf = analyserBufRef.current
      if (!analyser || !buf) return
      try {
        analyser.getByteTimeDomainData(buf)
        const next = barsFromTimeDomain(buf, DICTATION_WAVEFORM_BARS)
        setWaveform((prev) => {
          if (prev.length !== next.length) return next
          const mixed = new Array<number>(next.length)
          for (let i = 0; i < next.length; i++) {
            mixed[i] = prev[i]! * 0.4 + next[i]! * 0.6
          }
          return mixed
        })
      } catch {
        // keep last frame
      }
    }, reducedMotion ? 1000 : 50)
  }, [])

  const goIdle = useCallback(() => {
    setElapsedMs(0)
    setWaveform(quietWaveform())
    setPhase('idle')
  }, [])

  const cancelTranscription = useCallback(() => {
    const requestId = transcriptionIdRef.current
    transcriptionIdRef.current = null
    if (requestId && typeof window.vyotiq?.cancelDictation === 'function') {
      void window.vyotiq.cancelDictation(requestId)
    }
  }, [])

  const cancel = useCallback(() => {
    sessionGenRef.current += 1
    cancelTranscription()
    teardownCapture()
    goIdle()
  }, [cancelTranscription, goIdle, teardownCapture])

  const finishAndTranscribe = useCallback(async () => {
    clearTimer()
    stopMeter()
    const gen = activeGenRef.current
    const recorder = recorderRef.current
    recorderRef.current = null
    if (!recorder) {
      stopTracks()
      if (sessionGenRef.current === gen) goIdle()
      return
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data)
      }
      recorder.onerror = () => reject(new Error('Recording failed'))
      recorder.onstop = () => {
        const type = mimeRef.current.split(';')[0] || 'audio/webm'
        resolve(new Blob(chunksRef.current, { type }))
        chunksRef.current = []
        bytesRef.current = 0
      }
      try {
        if (recorder.state !== 'inactive') recorder.stop()
        else {
          const type = mimeRef.current.split(';')[0] || 'audio/webm'
          resolve(new Blob(chunksRef.current, { type }))
          chunksRef.current = []
          bytesRef.current = 0
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to stop recording'))
      }
    }).finally(() => {
      stopTracks()
    })

    if (sessionGenRef.current !== gen) return

    if (blob.size === 0) {
      publishError('No audio captured')
      goIdle()
      return
    }
    const byteCap =
      engineRef.current === 'local' || engineRef.current === 'qwen3-asr-onnx'
        ? MAX_LOCAL_AUDIO_BYTES
        : MAX_DICTATION_BYTES
    if (blob.size > byteCap) {
      publishError('Recording is too large to transcribe (limit reached)')
      goIdle()
      return
    }

    setPhase('transcribing')
    clearError()
    try {
      const data = await blobToBase64(blob)
      if (sessionGenRef.current !== gen) return
      const mime = blob.type || mimeRef.current.split(';')[0] || 'audio/webm'
      const engine = engineRef.current
      let pcm16k: string | undefined
      if (engine === 'local' || engine === 'qwen3-asr-onnx') {
        pcm16k = await blobToPcm16kBase64(blob)
      }
      if (sessionGenRef.current !== gen) return
      const requestId = crypto.randomUUID()
      transcriptionIdRef.current = requestId
      let result: Awaited<ReturnType<typeof window.vyotiq.transcribeDictation>>
      try {
        result = await window.vyotiq.transcribeDictation({
          requestId,
          data,
          mime,
          ...(pcm16k ? { pcm16k } : {})
        })
      } finally {
        if (transcriptionIdRef.current === requestId) transcriptionIdRef.current = null
      }
      if (sessionGenRef.current !== gen) return
      if (!result.ok) {
        const message = result.error || 'Dictation failed'
        publishError(message, classifyErrorAction(message, engine))
        goIdle()
        return
      }
      const transcript = result.data.text.trim()
      if (transcript) {
        const caret = caretAtStartRef.current
        const next = insertTranscriptAtCaret(textRef.current, transcript, caret)
        setText(next.text)
        setCaret?.(next.caret)
      }
      goIdle()
    } catch (err) {
      if (sessionGenRef.current !== gen) return
      const message = err instanceof Error ? err.message : 'Dictation failed'
      publishError(message, classifyErrorAction(message, engineRef.current))
      goIdle()
    }
  }, [clearError, clearTimer, goIdle, publishError, setCaret, setText, stopMeter, stopTracks])

  finishRef.current = () => {
    void finishAndTranscribe()
  }

  const startRecording = useCallback(async () => {
    if (disabled || startingRef.current) return
    if (phaseRef.current !== 'idle') return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      publishError('Microphone is not available in this environment')
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      publishError('Recording is not supported in this environment')
      return
    }

    startingRef.current = true
    sessionGenRef.current += 1
    const gen = sessionGenRef.current
    activeGenRef.current = gen
    caretAtStartRef.current = getCaret?.() ?? textRef.current.length
    clearError()
    phaseRef.current = 'checking'
    setPhase('checking')

    try {
      const ready = await preflightDictation(secretsRef.current)
      if (sessionGenRef.current !== gen) return
      if (!ready.ok) {
        publishError(ready.message, ready.settingsSection)
        goIdle()
        return
      }
      engineRef.current = ready.ctx.engine
      setEngineHint(formatDictationEngineHint(ready.ctx.engine, ready.ctx.localModelId))
      setWaveformStyle(ready.ctx.waveformStyle)

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (sessionGenRef.current !== gen) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      streamRef.current = stream
      const mime = pickRecorderMime()
      mimeRef.current = mime || 'audio/webm'
      chunksRef.current = []
      bytesRef.current = 0
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (ev) => {
        if (ev.data.size <= 0) return
        chunksRef.current.push(ev.data)
        bytesRef.current += ev.data.size
        if (
          bytesRef.current >= sizeStopBytes(engineRef.current) &&
          phaseRef.current === 'recording'
        ) {
          queueMicrotask(() => {
            if (phaseRef.current === 'recording' && sessionGenRef.current === gen) {
              finishRef.current()
            }
          })
        }
      }
      phaseRef.current = 'recording'
      recorder.start(250)
      startMeter(stream)
      setPhase('recording')
      timerRef.current = setTimeout(() => {
        if (phaseRef.current === 'recording' && sessionGenRef.current === gen) {
          void finishAndTranscribe()
        }
        }, ready.ctx.engine === 'local' || ready.ctx.engine === 'qwen3-asr-onnx'
          ? MAX_LOCAL_DICTATION_MS
          : MAX_DICTATION_MS)
    } catch (err) {
      if (sessionGenRef.current !== gen) return
      stopTracks()
      stopMeter()
      const msg = err instanceof Error ? err.message : String(err)
      if (/Permission|NotAllowed|denied/i.test(msg)) {
        publishError('Microphone permission denied')
      } else {
        publishError(msg || 'Could not start microphone')
      }
      goIdle()
    } finally {
      startingRef.current = false
    }
  }, [disabled, finishAndTranscribe, getCaret, goIdle, publishError, clearError, startMeter, stopMeter, stopTracks])

  const toggle = useCallback(() => {
    if (disabled) return
    if (phaseRef.current === 'recording') {
      void finishAndTranscribe()
      return
    }
    if (phaseRef.current === 'idle') {
      void startRecording()
    }
  }, [disabled, finishAndTranscribe, startRecording])

  useEffect(() => {
    return () => {
      sessionGenRef.current += 1
      cancelTranscription()
      teardownCapture()
    }
  }, [cancelTranscription, teardownCapture])

  useEffect(() => {
    let cancelled = false
    void loadDictationContext().then((ctx) => {
      if (cancelled) return
      engineRef.current = ctx.engine
      setEngineHint(formatDictationEngineHint(ctx.engine, ctx.localModelId))
      setWaveformStyle(ctx.waveformStyle)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!shortcutActive || disabled) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!matchShortcut(e, 'dictation')) return
      if (phaseRef.current === 'transcribing' || phaseRef.current === 'checking') return
      if (isShortcutTarget && !isShortcutTarget()) {
        if (!focusComposer || isEditableShortcutTarget(e.target)) return
        focusComposer()
      }
      e.preventDefault()
      e.stopPropagation()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [disabled, focusComposer, isShortcutTarget, shortcutActive, toggle])

  useEffect(() => {
    if (!shortcutActive || disabled) return
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id !== 'dictation') return
      if (phaseRef.current === 'transcribing' || phaseRef.current === 'checking') return
      toggle()
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [disabled, shortcutActive, toggle])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (e.defaultPrevented) return
      if (phaseRef.current === 'idle') return
      if (document.querySelector('[role="listbox"][aria-label="Slash commands"]')) return
      if (document.querySelector('[role="listbox"][aria-label="Mentions"]')) return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancel])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      if (phaseRef.current !== 'recording') return
      if (isEditableShortcutTarget(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      void finishAndTranscribe()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [finishAndTranscribe])

  return {
    phase,
    error,
    errorAction,
    setError: (next: string | null) => {
      if (next == null) clearError()
      else publishError(next)
    },
    waveform,
    elapsedMs,
    engineHint,
    waveformStyle,
    recording: phase === 'recording',
    transcribing: phase === 'transcribing',
    toggle,
    cancel,
    cancelRecording: cancel,
    startRecording,
    stopAndTranscribe: finishAndTranscribe
  }
}
