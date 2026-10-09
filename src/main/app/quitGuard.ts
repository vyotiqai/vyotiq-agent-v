/**
 * What closing the window and quitting do while tasks run.
 *
 * Runs, loops and schedules live in this process: closing the last window on
 * Windows and Linux quits the app, and quitting stops every running task. So
 * closing either hides the window to the tray (the setting, or a choice in the
 * question), or asks first when tasks are running. A quit someone already
 * chose elsewhere — installing an update, deleting app data — is marked
 * confirmed and never asks.
 */

export type CloseChoice = 'hide' | 'quit' | 'cancel'

export type CloseQuestion = {
  message: string
  detail: string
  buttons: string[]
  /** Index of each answer in `buttons`. */
  quit: number
  hide: number | null
  cancel: number
  checkboxLabel?: string
}

export type CloseAnswer = { response: number; checkboxChecked: boolean }

let confirmed = false

/** A quit chosen elsewhere (update install, data wipe): no question. */
export function markQuitConfirmed(): void {
  confirmed = true
}

export function quitConfirmed(): boolean {
  return confirmed
}

/** The question was answered "keep going": the next quit asks again. */
export function clearQuitConfirmed(): void {
  confirmed = false
}

export function resetQuitGuardForTests(): void {
  confirmed = false
}

export function closeQuestion(activeRuns: number, trayAvailable: boolean): CloseQuestion {
  const tasks = `${activeRuns} task${activeRuns === 1 ? ' is' : 's are'} running`
  const buttons = trayAvailable
    ? ['Keep running in the tray', 'Quit and stop them', 'Cancel']
    : ['Quit and stop them', 'Cancel']
  return {
    message: `Quit Agent V? ${tasks}.`,
    detail: trayAvailable
      ? 'Quitting stops them, and loops and scheduled tasks wait until Agent V is open again. In the tray they keep going.'
      : 'Quitting stops them, and loops and scheduled tasks wait until Agent V is open again.',
    buttons,
    quit: trayAvailable ? 1 : 0,
    hide: trayAvailable ? 0 : null,
    cancel: trayAvailable ? 2 : 1,
    ...(trayAvailable ? { checkboxLabel: 'Always keep running in the tray when I close the window' } : {})
  }
}

/**
 * Decide what a window close does. `ask` shows the question (a message box in
 * the app); `rememberTray` saves "always keep running in the tray".
 */
export async function chooseOnClose(opts: {
  activeRuns: number
  closeToTray: boolean
  confirmQuit: boolean
  trayAvailable: boolean
  ask: (question: CloseQuestion) => Promise<CloseAnswer>
  rememberTray: () => void
}): Promise<CloseChoice> {
  if (confirmed) return 'quit'
  if (opts.closeToTray && opts.trayAvailable) return 'hide'
  if (opts.activeRuns <= 0 || !opts.confirmQuit) return 'quit'
  const question = closeQuestion(opts.activeRuns, opts.trayAvailable)
  const answer = await opts.ask(question)
  if (question.hide !== null && answer.response === question.hide) {
    if (answer.checkboxChecked) opts.rememberTray()
    return 'hide'
  }
  if (answer.response === question.quit) {
    confirmed = true
    return 'quit'
  }
  return 'cancel'
}

/**
 * Decide whether a quit (menu, tray, Ctrl+Q) goes ahead. No tray choice here:
 * the person asked to quit, not to close a window.
 */
export async function confirmQuit(opts: {
  activeRuns: number
  confirmQuit: boolean
  ask: (question: CloseQuestion) => Promise<CloseAnswer>
}): Promise<boolean> {
  if (confirmed || opts.activeRuns <= 0 || !opts.confirmQuit) return true
  const question = closeQuestion(opts.activeRuns, false)
  const answer = await opts.ask(question)
  if (answer.response === question.quit) {
    confirmed = true
    return true
  }
  return false
}
