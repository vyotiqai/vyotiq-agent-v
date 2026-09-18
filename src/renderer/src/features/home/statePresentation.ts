import type { IconName } from '@renderer/lib/icons'
import type { HomeEntryState } from './homeEntries'

export type StatePresentation = {
  icon: IconName
  label: string
  /**
   * One sentence naming the condition the code actually checks — what put the
   * session in this state, not advice about it. The attention lane header
   * states it once for the whole group.
   */
  detail: string
  tone: string
  spin?: boolean
}

/**
 * How each row state is named and coloured. Shared by the lane header and the
 * rows under it so the two can never disagree about a state's severity.
 */
export const STATE_PRESENTATION: Record<Exclude<HomeEntryState, 'done'>, StatePresentation> = {
  blocked: {
    icon: 'bell',
    label: 'Waiting on you',
    detail: 'The agent asked a question or needs a tool approved before it can go on.',
    tone: 'text-warning'
  },
  failed: {
    icon: 'close',
    label: 'Failed',
    detail: 'The run ended on an error without finishing.',
    tone: 'text-danger'
  },
  interrupted: {
    icon: 'warning',
    label: 'Interrupted',
    detail: 'The app exited while the run was active. These can be resumed.',
    tone: 'text-warning'
  },
  unverified: {
    icon: 'warning',
    label: 'Unverified edits',
    detail: 'Files changed after the last check ran, so nothing has re-verified them.',
    tone: 'text-warning'
  },
  running: {
    icon: 'loader',
    label: 'Running',
    detail: 'Working now.',
    tone: 'text-accent',
    spin: true
  }
}
