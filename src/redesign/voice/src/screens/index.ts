import type { ComponentType } from 'react'
import { AuditScreen } from './Audit'
import { BriefFailed, BriefListening } from './BriefScreens'
import { SettingsCloudNoKey, SettingsInstalling, SettingsLocal } from './SettingsScreens'
import { SheetScreen } from './Sheet'
import {
  LineBlocked,
  LineDiscarded,
  LineFailed,
  LineFinishing,
  LineHold,
  LineIdle,
  LineInserted,
  LineLimit,
  LineListening,
  LinePending,
  LineSetup,
  LineSetupInstalling,
  LineSilent
} from './TaskScreens'

export type Screen = { id: string; group: string; label: string; note: string; Component: ComponentType }

/** Every screen, in the order a user meets them. */
export const SCREENS: Screen[] = [
  { id: 'audit', group: 'Start here', label: 'Audit · today', note: 'The shipped dictation UI (real components) and 14 numbered findings.', Component: AuditScreen },
  { id: 'sheet', group: 'Start here', label: 'Parts sheet', note: 'A take’s life, every strip state at 1:1, the mic’s four faces, the keys.', Component: SheetScreen },

  { id: 'line-idle', group: 'Instruction line', label: 'Idle · mic tooltip', note: 'The verb, its chord, hold-to-talk, and where audio goes — before you press.', Component: LineIdle },
  { id: 'line-listening', group: 'Instruction line', label: 'Listening', note: 'Your text stays. Settled words land at the caret; the unsettled tail is quiet.', Component: LineListening },
  { id: 'line-pending', group: 'Instruction line', label: 'Listening · cloud', note: 'An engine that answers only at the end: a marker holds the place.', Component: LinePending },
  { id: 'line-hold', group: 'Instruction line', label: 'Hold to talk', note: 'Shortcut held. Letting go inserts; no buttons needed.', Component: LineHold },
  { id: 'line-silent', group: 'Instruction line', label: 'Nothing heard', note: '4 s of silence: name the device, offer another — before a wasted take.', Component: LineSilent },
  { id: 'line-limit', group: 'Instruction line', label: 'Near the cap', note: 'Time left shows only in the last minute of a take.', Component: LineLimit },
  { id: 'line-finishing', group: 'Instruction line', label: 'Finishing', note: 'Settling the last words, with progress where the engine reports it.', Component: LineFinishing },
  { id: 'line-inserted', group: 'Instruction line', label: 'Inserted', note: 'What the take added stays tinted; Undo sits where the strip was.', Component: LineInserted },
  { id: 'line-discarded', group: 'Instruction line', label: 'Discarded', note: 'Esc is no longer final: Restore for a few seconds.', Component: LineDiscarded },
  { id: 'line-failed', group: 'Instruction line', label: 'Failed · audio kept', note: 'Retry without re-speaking, or hand the audio to the other engine.', Component: LineFailed },

  { id: 'brief-listening', group: 'New task', label: 'Dictating a brief', note: 'Long takes happen here; the strip takes the box’s bottom row.', Component: BriefListening },
  { id: 'brief-failed', group: 'New task', label: 'Brief · offline', note: 'Two minutes of talking survive a dropped connection.', Component: BriefFailed },

  { id: 'setup', group: 'First use', label: 'Set up at the mic', note: 'Nothing configured: choose how it runs right here, not in an error banner.', Component: LineSetup },
  { id: 'setup-installing', group: 'First use', label: 'Installing', note: 'Keep typing; the mic opens by itself when the model is ready.', Component: LineSetupInstalling },
  { id: 'blocked', group: 'First use', label: 'Mic blocked', note: 'Windows refused: draw the two switches and link straight to them.', Component: LineBlocked },

  { id: 'settings', group: 'Settings', label: 'Voice · This PC', note: 'Where audio goes, the model, the microphone with a live level, and the keys.', Component: SettingsLocal },
  { id: 'settings-installing', group: 'Settings', label: 'Voice · installing', note: 'A download is a row’s own state, not a hint and a button apart.', Component: SettingsInstalling },
  { id: 'settings-cloud', group: 'Settings', label: 'Voice · cloud, no key', note: 'The one blocker, said on the row that causes it, with its fix.', Component: SettingsCloudNoKey }
]

export const SKINS = ['native', 'default', 'proof', 'bench', 'gild'] as const
export type Skin = (typeof SKINS)[number]
export type Theme = 'light' | 'dark'

export const SIZES = {
  '1440': { w: 1440, h: 900, label: '1440 × 900' },
  '1920': { w: 1920, h: 1080, label: '1920 × 1080' },
  '1280': { w: 1280, h: 800, label: '1280 × 800' }
} as const
export type SizeId = keyof typeof SIZES
