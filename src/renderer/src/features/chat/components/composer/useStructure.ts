import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  AgentInteractionMode,
  PromptStructureAnswer,
  PromptStructureQuestion,
  PromptTaskType
} from '@shared/ipc'
import {
  briefToDraft,
  draftToStructureInput,
  moveDoneWhenToChecks,
  structureEligibility,
  structuredFromText,
  type StructureEligibility
} from './structureDraft'

/**
 * Structure, as the composer holds it: the call in flight, the questions it
 * asked, or the brief it wrote with the words it replaced — so Undo can put
 * them back and the sent message can keep them for the record.
 */
export type StructurePhase =
  | { kind: 'idle' }
  | { kind: 'working'; requestId: string; original: string; answering: boolean }
  | { kind: 'asking'; original: string; taskType: PromptTaskType; questions: PromptStructureQuestion[] }
  | {
      kind: 'done'
      original: string
      draft: string
      taskType: PromptTaskType
      notFound: string[]
      reused: boolean
      /** False once its strip is closed: still a brief Structure wrote, just out of the way. */
      shown: boolean
      /** The checks its Done when bullets became, once moved — Undo takes them back out. */
      movedChecks?: string[]
    }
  | { kind: 'error'; original: string; message: string }

export type StructureHandle = {
  phase: StructurePhase
  eligibility: StructureEligibility
  /** Writing or asking: the field is held, Send waits. */
  holding: boolean
  start: () => void
  answer: (answers: PromptStructureAnswer[]) => void
  skipQuestions: () => void
  retry: () => void
  cancel: () => void
  undo: () => void
  dismiss: () => void
  /** New task: how many of the brief's Done when bullets would become checks; 0 when none or done. */
  checksToMove: number
  /** New task: the brief's Done when bullets become the page's checks, out of the brief. */
  moveChecks: () => void
  /** The words to keep on a message sent with this text, when it is a brief Structure wrote. */
  structuredFromFor: (sentDraft: string) => string | undefined
  /** The message went: Structure starts over. */
  onSent: () => void
}

export type StructureState = [StructurePhase, Dispatch<SetStateAction<StructurePhase>>]

/** New task's done-when checks, which a brief's Done when bullets can move into. */
export type StructureChecks = { list: readonly string[]; set: (next: string[]) => void }

/**
 * Structure's state, made before the composer's draft hook so that hook's
 * send gate reads the same render's phase — the hook that acts on it needs
 * the draft, so it comes after.
 */
export function useStructureState(): StructureState {
  return useState<StructurePhase>({ kind: 'idle' })
}

/** Writing or asking: the field is held, and Send waits. */
export function structureHolds(phase: StructurePhase): boolean {
  return phase.kind === 'working' || phase.kind === 'asking'
}

let requestSeq = 0
function nextRequestId(): string {
  requestSeq += 1
  return `structure-${Date.now().toString(36)}-${requestSeq}`
}

export function useStructure({
  state,
  workspacePath,
  runId,
  mode,
  provider,
  model,
  text,
  setText,
  checks,
  enabled
}: {
  state: StructureState
  workspacePath: string | null | undefined
  runId: string | null | undefined
  mode: AgentInteractionMode
  provider: string
  model: string
  text: string
  setText: (next: string) => void
  /** New task only: the page's checks. Absent everywhere else. */
  checks?: StructureChecks | null
  /** False when the composer is locked or has no workspace. */
  enabled: boolean
}): StructureHandle {
  const [phase, setPhase] = state
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const textRef = useRef(text)
  textRef.current = text
  const checksRef = useRef(checks)
  checksRef.current = checks
  const eligibility = useMemo(() => structureEligibility(text), [text])

  // A call belongs to the task it was asked in: switching task or workspace drops it.
  const scopeKey = `${workspacePath ?? ''}::${runId ?? ''}`
  const scopeRef = useRef(scopeKey)

  const cancelInFlight = useCallback((): void => {
    const current = phaseRef.current
    if (current.kind === 'working') void window.vyotiq?.promptStructureCancel?.({ requestId: current.requestId })
  }, [])

  useEffect(() => {
    if (scopeRef.current === scopeKey) return
    scopeRef.current = scopeKey
    cancelInFlight()
    setPhase({ kind: 'idle' })
  }, [scopeKey, cancelInFlight])

  // Unmounting mid-call: stop paying for a brief nobody will see.
  useEffect(() => () => cancelInFlight(), [cancelInFlight])

  const run = useCallback(
    (original: string, opts: { answers?: PromptStructureAnswer[]; noQuestions?: boolean; force?: boolean } = {}): void => {
      const api = window.vyotiq?.promptStructure
      if (!api || !workspacePath) return
      const input = draftToStructureInput(original)
      if (!input.text) return
      const requestId = nextRequestId()
      const scope = scopeRef.current
      setPhase({ kind: 'working', requestId, original, answering: Boolean(opts.answers?.length) })
      void api({
        requestId,
        workspacePath,
        text: input.text,
        mentions: input.mentions,
        mode,
        ...(runId ? { runId } : {}),
        ...(provider && model ? { provider, model } : {}),
        ...(opts.answers?.length ? { answers: opts.answers } : {}),
        ...(opts.noQuestions ? { noQuestions: true } : {}),
        ...(opts.force ? { force: true } : {})
      }).then(
        (res) => {
          const current = phaseRef.current
          // Cancelled, superseded, or asked in another task: not ours to show.
          if (current.kind !== 'working' || current.requestId !== requestId || scopeRef.current !== scope) return
          if (!res.ok) {
            setPhase({ kind: 'error', original, message: res.error })
            return
          }
          const result = res.data
          switch (result.kind) {
            case 'cancelled':
              setPhase({ kind: 'idle' })
              return
            case 'unavailable':
              setPhase({ kind: 'error', original, message: result.reason })
              return
            case 'questions':
              setPhase({ kind: 'asking', original, taskType: result.taskType, questions: result.questions })
              return
            case 'brief': {
              const draft = briefToDraft(result.brief, input.markers)
              setText(draft)
              setPhase({
                kind: 'done',
                original,
                draft,
                taskType: result.taskType,
                notFound: result.notFound ?? [],
                reused: result.reused === true,
                shown: true
              })
            }
          }
        },
        (err: unknown) => {
          const current = phaseRef.current
          if (current.kind !== 'working' || current.requestId !== requestId) return
          setPhase({ kind: 'error', original, message: err instanceof Error ? err.message : 'Could not write the brief' })
        }
      )
    },
    [workspacePath, runId, mode, provider, model, setText]
  )

  const start = useCallback((): void => {
    if (!enabled || phaseRef.current.kind === 'working' || phaseRef.current.kind === 'asking') return
    if (!structureEligibility(textRef.current).ok) return
    run(textRef.current)
  }, [enabled, run])

  const answer = useCallback(
    (answers: PromptStructureAnswer[]): void => {
      const current = phaseRef.current
      if (current.kind !== 'asking') return
      run(current.original, answers.length ? { answers } : { noQuestions: true })
    },
    [run]
  )

  const skipQuestions = useCallback((): void => {
    const current = phaseRef.current
    if (current.kind === 'asking') run(current.original, { noQuestions: true })
  }, [run])

  /** The checks a brief's Done when became go when the brief does — each once; an edited one stays. */
  const takeBackChecks = useCallback((current: StructurePhase): void => {
    const target = checksRef.current
    if (current.kind !== 'done' || !current.movedChecks?.length || !target) return
    const next = [...target.list]
    for (const text of current.movedChecks) {
      const index = next.indexOf(text)
      if (index >= 0) next.splice(index, 1)
    }
    if (next.length !== target.list.length) target.set(next)
  }, [])

  /** Another brief for the same words — a fresh call, not the one remembered. */
  const retry = useCallback((): void => {
    const current = phaseRef.current
    if (current.kind !== 'done' && current.kind !== 'error') return
    if (current.kind === 'done') {
      takeBackChecks(current)
      setText(current.original)
    }
    run(current.original, { force: true })
  }, [run, setText, takeBackChecks])

  const cancel = useCallback((): void => {
    const current = phaseRef.current
    if (current.kind === 'working') {
      void window.vyotiq?.promptStructureCancel?.({ requestId: current.requestId })
      // The field never changed while it worked: the words are still there.
      setPhase({ kind: 'idle' })
    } else if (current.kind === 'asking') {
      setPhase({ kind: 'idle' })
    }
  }, [])

  const undo = useCallback((): void => {
    const current = phaseRef.current
    if (current.kind !== 'done') return
    takeBackChecks(current)
    setText(current.original)
    setPhase({ kind: 'idle' })
  }, [setText, takeBackChecks])

  const checksList = checks?.list
  const checksToMove = useMemo(() => {
    if (phase.kind !== 'done' || phase.movedChecks || !checksList) return 0
    return moveDoneWhenToChecks(text, checksList)?.added.length ?? 0
  }, [phase, text, checksList])

  const moveChecks = useCallback((): void => {
    const current = phaseRef.current
    const target = checksRef.current
    if (current.kind !== 'done' || current.movedChecks || !target) return
    const move = moveDoneWhenToChecks(textRef.current, target.list)
    if (!move) return
    target.set(move.checks)
    setText(move.draft)
    // The brief as it reads now is still Structure's: Ctrl+Z right after undoes it whole.
    setPhase({ ...current, draft: move.draft, movedChecks: move.added })
  }, [setText])

  const dismiss = useCallback((): void => {
    const current = phaseRef.current
    if (current.kind === 'error') setPhase({ kind: 'idle' })
    // A brief that is kept stays known as one, so the record still says where it came from.
    if (current.kind === 'done') setPhase({ ...current, shown: false })
  }, [])

  const structuredFromFor = useCallback((sentDraft: string): string | undefined => {
    const current = phaseRef.current
    if (current.kind !== 'done') return undefined
    if (sentDraft.trim() === current.original.trim()) return undefined
    const words = structuredFromText(current.original)
    return words || undefined
  }, [])

  const onSent = useCallback((): void => {
    setPhase({ kind: 'idle' })
  }, [])

  // Emptying the field ends a brief: there is nothing left for Undo to replace.
  useEffect(() => {
    if (phase.kind === 'done' && !text.trim()) setPhase({ kind: 'idle' })
  }, [phase.kind, text])

  const holding = structureHolds(phase)

  // Esc while it works or asks: cancel that. The app's Esc-stops-the-run yields to it.
  useEffect(() => {
    if (!holding) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      e.preventDefault()
      cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [holding, cancel])

  return {
    phase,
    eligibility,
    holding,
    start,
    answer,
    skipQuestions,
    retry,
    cancel,
    undo,
    dismiss,
    checksToMove,
    moveChecks,
    structuredFromFor,
    onSent
  }
}
