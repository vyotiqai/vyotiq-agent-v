import { BRIEF_TEXT, DICTATED, STEER, STRUCTURED, TYPED, type Segment } from './data'
import type { Scene } from './store'

const EMPTY: Segment[] = []

const base: Scene = {
  surface: 'line',
  running: false,
  segments: EMPTY,
  attachments: false,
  followUps: false,
  take: null,
  structure: null,
  readiness: false,
  error: false,
  micReady: true,
  pop: null
}

export type SceneId =
  | 'idle'
  | 'typing'
  | 'running'
  | 'steer'
  | 'dictation'
  | 'inserted'
  | 'structuring'
  | 'structured'
  | 'readiness'
  | 'error'
  | 'pop-model'
  | 'pop-context'
  | 'pop-attach'
  | 'pop-mic'
  | 'pop-mention'
  | 'pop-slash'
  | 'inline'
  | 'brief'

export const SCENES: { id: SceneId; label: string; group: string; scene: Scene }[] = [
  { id: 'idle', group: 'Instruction line', label: 'Empty', scene: base },
  { id: 'typing', group: 'Instruction line', label: 'Typed, with chips and files', scene: { ...base, segments: TYPED, attachments: true } },
  { id: 'running', group: 'Instruction line', label: 'Running, two queued', scene: { ...base, running: true, followUps: true } },
  { id: 'steer', group: 'Instruction line', label: 'Running, with text (Send now)', scene: { ...base, running: true, segments: STEER } },
  { id: 'dictation', group: 'Instruction line', label: 'Dictating', scene: { ...base, take: 'listening' } },
  { id: 'inserted', group: 'Instruction line', label: 'Dictation inserted', scene: { ...base, take: 'inserted' } },
  { id: 'structuring', group: 'Instruction line', label: 'Structure writing', scene: { ...base, structure: 'working', segments: TYPED } },
  { id: 'structured', group: 'Instruction line', label: 'Structured', scene: { ...base, structure: 'done', segments: STRUCTURED } },
  { id: 'readiness', group: 'Instruction line', label: 'No API key', scene: { ...base, readiness: true } },
  { id: 'error', group: 'Instruction line', label: 'Run failed', scene: { ...base, error: true } },

  { id: 'pop-model', group: 'Popovers', label: 'Model and effort', scene: { ...base, pop: 'model' } },
  { id: 'pop-context', group: 'Popovers', label: 'Context details', scene: { ...base, pop: 'context' } },
  { id: 'pop-attach', group: 'Popovers', label: 'Attach', scene: { ...base, pop: 'attach' } },
  { id: 'pop-mic', group: 'Popovers', label: 'Dictate with', scene: { ...base, micReady: false, pop: 'mic' } },
  { id: 'pop-mention', group: 'Popovers', label: '@ Mentions', scene: { ...base, segments: [{ type: 'text', value: 'Compare it with @' }], pop: 'mention' } },
  { id: 'pop-slash', group: 'Popovers', label: '/ Slash commands', scene: { ...base, segments: [{ type: 'text', value: '/' }], pop: 'slash' } },

  { id: 'inline', group: 'Other surfaces', label: 'Edit and rerun', scene: { ...base, surface: 'inline', segments: TYPED } },
  { id: 'brief', group: 'Other surfaces', label: 'New task brief', scene: { ...base, surface: 'brief', segments: BRIEF_TEXT } }
]

export const LIVE_WORDS = { settled: 'make the context meter open upward ', partial: DICTATED.slice('make the context meter open upward '.length) }
export const INSERTED_WORDS = DICTATED

export function hasContent(scene: Scene): boolean {
  return scene.attachments || scene.segments.some((s) => s.type === 'chip' || s.value.trim().length > 0) || scene.take === 'inserted'
}
