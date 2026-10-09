import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseOnClose,
  closeQuestion,
  confirmQuit,
  markQuitConfirmed,
  resetQuitGuardForTests,
  type CloseAnswer
} from '@main/app/quitGuard'

afterEach(() => resetQuitGuardForTests())

const base = { closeToTray: false, confirmQuit: true, trayAvailable: true, rememberTray: vi.fn() }

describe('chooseOnClose', () => {
  it('closes without asking when nothing runs', async () => {
    const ask = vi.fn()
    expect(await chooseOnClose({ ...base, activeRuns: 0, ask })).toBe('quit')
    expect(ask).not.toHaveBeenCalled()
  })

  it('hides to the tray when that is the setting, running or not', async () => {
    const ask = vi.fn()
    expect(await chooseOnClose({ ...base, closeToTray: true, activeRuns: 2, ask })).toBe('hide')
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks with tasks running, and can remember the tray', async () => {
    const rememberTray = vi.fn()
    const q = closeQuestion(2, true)
    const ask = vi.fn(async (_question: { message: string }): Promise<CloseAnswer> => ({ response: q.hide!, checkboxChecked: true }))
    expect(await chooseOnClose({ ...base, activeRuns: 2, ask, rememberTray })).toBe('hide')
    expect(ask.mock.calls[0]![0].message).toBe('Quit Agent V? 2 tasks are running.')
    expect(rememberTray).toHaveBeenCalledOnce()
  })

  it('quits on "Quit and stop them", and the quit that follows does not ask again', async () => {
    const q = closeQuestion(1, true)
    const ask = vi.fn(async (): Promise<CloseAnswer> => ({ response: q.quit, checkboxChecked: false }))
    expect(await chooseOnClose({ ...base, activeRuns: 1, ask })).toBe('quit')
    const again = vi.fn()
    expect(await confirmQuit({ activeRuns: 1, confirmQuit: true, ask: again })).toBe(true)
    expect(again).not.toHaveBeenCalled()
  })

  it('stays open on Cancel', async () => {
    const q = closeQuestion(1, true)
    const ask = vi.fn(async (): Promise<CloseAnswer> => ({ response: q.cancel, checkboxChecked: false }))
    expect(await chooseOnClose({ ...base, activeRuns: 1, ask })).toBe('cancel')
  })

  it('offers no tray choice without a tray', () => {
    const q = closeQuestion(3, false)
    expect(q.buttons).toEqual(['Quit and stop them', 'Cancel'])
    expect(q.hide).toBeNull()
    expect(q.checkboxLabel).toBeUndefined()
  })
})

describe('confirmQuit', () => {
  it('does not ask for a quit already chosen elsewhere', async () => {
    markQuitConfirmed()
    const ask = vi.fn()
    expect(await confirmQuit({ activeRuns: 4, confirmQuit: true, ask })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('respects the setting being off', async () => {
    const ask = vi.fn()
    expect(await confirmQuit({ activeRuns: 4, confirmQuit: false, ask })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps the app open when the answer is Cancel', async () => {
    const ask = vi.fn(async (): Promise<CloseAnswer> => ({ response: 1, checkboxChecked: false }))
    expect(await confirmQuit({ activeRuns: 1, confirmQuit: true, ask })).toBe(false)
  })
})
