import { useEffect, useMemo, useState } from 'react'
import { VOICE_STATE_LABEL, type VoiceSessionState } from '@shared/voiceSession'
import { LiveOrb } from './LiveOrb'
import { fakeLevel } from './Orb'

/*
  The orb on its own: one large orb living through a conversation (each
  change eases across), and every state side by side at the size the views
  use. Scaffolding for judging the motion, not a screen in the app.
*/

const STORY: { state: VoiceSessionState; ms: number; line: string }[] = [
  { state: 'listening', ms: 2600, line: 'Waiting for you to talk' },
  { state: 'hearing', ms: 3200, line: '“The settings test keeps failing on Windows…”' },
  { state: 'thinking', ms: 1800, line: 'Working out an answer' },
  { state: 'speaking', ms: 2200, line: '“On it. I’ll have it look at the settings test.”' },
  { state: 'working', ms: 4200, line: 'Running pnpm vitest run tests/main/unit/settings.test.ts' },
  { state: 'waiting_on_you', ms: 3000, line: 'Allow it to run git stash? Say yes or no' },
  { state: 'working', ms: 2400, line: 'Running pnpm vitest run tests/main/unit/settings.test.ts' },
  { state: 'speaking', ms: 3600, line: '“Fixed. It uses path.join now, and all 14 pass.”' },
  { state: 'paused', ms: 2200, line: 'Muted' }
]

const ALL: VoiceSessionState[] = ['listening', 'hearing', 'thinking', 'working', 'speaking', 'waiting_on_you', 'paused', 'connecting', 'reconnecting', 'error']

export function Gallery() {
  const level = useMemo(() => fakeLevel(), [])
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setI((i + 1) % STORY.length), STORY[i]!.ms)
    return () => clearTimeout(t)
  }, [i])
  const now = STORY[i]!

  return (
    <div className="flex h-full bg-bg font-sans text-fg" data-vv-gallery>
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-5 border-r border-border">
        <LiveOrb state={now.state} size={320} level={level} />
        <p className="m-0 text-title text-fg-strong">{VOICE_STATE_LABEL[now.state]}</p>
        <p className="m-0 h-5 max-w-[440px] truncate text-sm text-muted">{now.line}</p>
      </div>
      <div className="grid w-[520px] shrink-0 grid-cols-3 content-center gap-x-4 gap-y-6 p-6">
        {ALL.map((s) => (
          <div key={s} className="flex flex-col items-center gap-1.5">
            <LiveOrb state={s} size={120} level={level} />
            <span className="text-caption text-tertiary">{VOICE_STATE_LABEL[s]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
