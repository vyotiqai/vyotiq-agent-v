import { useContext } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { AnimatedOrb } from '@renderer/features/voice/orb/AnimatedOrb'
import { OrbLookContext } from './orbShared'

/** The app's orb (features/voice/orb) in whichever look the viewer's Orb menu picked. */
export function LiveOrb({ state, size, level }: { state: VoiceSessionState; size: number; level?: () => number }) {
  return <AnimatedOrb look={useContext(OrbLookContext)} state={state} size={size} level={level} />
}
