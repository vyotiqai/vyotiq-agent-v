import { createContext } from 'react'
import type { VoiceOrbLook } from '@shared/ipc/schemas/voice'

/** Which orb look the viewer's Orb menu picked; the orbs themselves are the app's (features/voice/orb). */
export const OrbLookContext = createContext<VoiceOrbLook>('glow')
