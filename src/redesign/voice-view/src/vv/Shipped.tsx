import { useContext, useMemo, useState } from 'react'
import { DEFAULT_VOICE_SETTINGS, type VoiceViewLayout, type VoiceWork } from '@shared/ipc/schemas/voice'
import { ConversationLayout, OrbLayout, SplitLayout, type LayoutProps } from '@renderer/features/voice/view/layouts'
import { IDLE_VOICE, type VoiceSnapshot } from '@renderer/features/voice/voiceSessionController'
import type { Scene, Work } from './data'
import { fakeLevel } from './Orb'
import { OrbLookContext } from './orbShared'

/*
  The app's own voice view (features/voice/view) on the mockup's scenes: what
  shipped, beside the directions it came from. The scene becomes the
  controller's snapshot (transcript, each hand-off's run and its work), so
  this is the real component with made-up data, not a drawing of it.
*/

/** The scene's verbs back to the tool names the app labels itself. */
const TOOL: Record<string, string> = {
  Searched: 'grep',
  Read: 'read',
  Ran: 'terminal',
  Running: 'terminal',
  Edited: 'edit',
  'Wants to run': 'terminal'
}

/** "1 min 12 s" → ms. */
function parseElapsed(text: string): number {
  const m = /(?:(\d+) min )?(\d+) s/.exec(text)
  return m ? (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 : 0
}

function toWork(id: string, w: Work, now: number): VoiceWork {
  const ran = parseElapsed(w.elapsed)
  const ended = w.state === 'done' || w.state === 'failed'
  return {
    runId: id,
    state: w.state,
    startedAt: now - ran,
    ...(ended ? { endedAt: now } : {}),
    stepCount: w.steps.length,
    steps: w.steps.map((s) => ({ id: s.id, tool: TOOL[s.tool] ?? 'read', summary: s.summary, state: s.state })),
    ...(w.result ? { result: w.result } : {}),
    ...(w.ask?.kind === 'approval' ? { ask: { kind: 'approval' as const, requestId: 'q1', what: `run ${w.ask.command}`, risky: false } } : {})
  }
}

function toSnapshot(scene: Scene, now: number): VoiceSnapshot {
  const works: Record<string, VoiceWork> = {}
  const transcript = scene.entries.map((e) => {
    if (e.who !== 'work') return { id: e.id, who: e.who, text: e.text }
    works[e.id] = toWork(e.id, e.work, now)
    return { id: e.id, who: 'agent' as const, text: e.work.brief, runId: e.id }
  })
  return {
    ...IDLE_VOICE,
    state: scene.state,
    partial: scene.partial ?? '',
    saying: scene.saying ?? '',
    lastTurn: [...scene.entries].reverse().find((e) => e.who === 'you')?.who === 'you' ? 'Can you find out why and fix it?' : '',
    listener: 'openrouter',
    speaker: 'openrouter',
    muted: scene.muted ?? false,
    ...(scene.problem ? { error: 'out_of_credit' as const, errorDetail: scene.problem.detail ?? '' } : {}),
    transcript,
    works
  }
}

export function Shipped({ scene, layout }: { scene: Scene; layout: VoiceViewLayout }) {
  const look = useContext(OrbLookContext)
  const level = useMemo(() => fakeLevel(), [])
  const [now] = useState(() => Date.now())
  const props: LayoutProps = {
    v: toSnapshot(scene, now),
    settings: { ...DEFAULT_VOICE_SETTINGS, viewLayout: layout, orbLook: look },
    startedAt: now - parseElapsed(scene.time.replace(/^(\d+):(\d+)$/, '$1 min $2 s')),
    escArmed: false,
    firstTip: false,
    owner: 'mockup',
    workspacePath: null,
    level
  }
  return (
    <div className="relative min-w-0 flex-1" data-vv-shipped={layout}>
      {layout === 'orb' ? <OrbLayout {...props} /> : layout === 'split' ? <SplitLayout {...props} /> : <ConversationLayout {...props} />}
    </div>
  )
}
