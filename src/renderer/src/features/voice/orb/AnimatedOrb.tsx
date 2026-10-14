import type { VoiceOrbLook } from '@shared/ipc/schemas/voice'
import type { VoiceSessionState } from '@shared/voiceSession'
import { VoiceOrb } from '../VoiceOrb'
import { LiquidOrb } from './LiquidOrb'
import { SHADER_LOOKS } from './orbLooks'
import { ShaderOrb } from './ShaderOrb'

/*
  The voice orb in the look chosen in Settings › Voice mode (§25). Below
  MIN_ANIMATED_SIZE the drawn orb is used whatever the look: at 20–28 px its
  rings, slash and bar say the state, where a shader would be a coloured dot.
*/

export const MIN_ANIMATED_SIZE = 40

export const ORB_LOOK_OPTIONS: readonly { value: VoiceOrbLook; label: string; description: string }[] = [
  ...(Object.keys(SHADER_LOOKS) as (keyof typeof SHADER_LOOKS)[]).map((id) => ({
    value: id,
    label: SHADER_LOOKS[id].label,
    description: SHADER_LOOKS[id].note
  })),
  { value: 'liquid', label: 'Liquid', description: 'Colour flowing inside a glass sphere' },
  { value: 'simple', label: 'Simple', description: 'A drawn orb: no animation beyond its state, and no GPU' }
]

export function AnimatedOrb({
  look,
  state,
  size,
  level
}: {
  look: VoiceOrbLook
  state: VoiceSessionState
  size: number
  /** 0..1, read every frame while hearing or speaking. */
  level?: () => number
}) {
  if (look === 'simple' || size < MIN_ANIMATED_SIZE) return <VoiceOrb state={state} size={size} level={level} />
  if (look === 'liquid') return <LiquidOrb state={state} size={size} level={level} />
  return <ShaderOrb look={look} state={state} size={size} level={level} />
}
