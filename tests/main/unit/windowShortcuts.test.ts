import { beforeEach, describe, expect, it, vi } from 'vitest'

const toolkit = vi.hoisted(() => ({ is: { dev: false } }))

vi.mock('electron', () => ({ BrowserWindow: class {} }))
vi.mock('@electron-toolkit/utils', () => toolkit)

import { watchWindowShortcuts } from '../../../src/main/app/windowShortcuts'

type Handler = (event: { preventDefault: () => void }, input: Record<string, unknown>) => void

function harness(): { press: (input: Record<string, unknown>) => { prevented: boolean }; scripts: string[] } {
  let handler: Handler | null = null
  const scripts: string[] = []
  const webContents = {
    on: (name: string, fn: Handler) => {
      if (name === 'before-input-event') handler = fn
    },
    executeJavaScript: (code: string) => {
      scripts.push(code)
      return Promise.resolve()
    },
    isDevToolsOpened: () => false,
    openDevTools: vi.fn(),
    closeDevTools: vi.fn()
  }
  watchWindowShortcuts({ webContents } as unknown as Parameters<typeof watchWindowShortcuts>[0])
  return {
    press: (input) => {
      let prevented = false
      handler!({ preventDefault: () => (prevented = true) }, { type: 'keyDown', ...input })
      return { prevented }
    },
    scripts
  }
}

describe('watchWindowShortcuts', () => {
  beforeEach(() => {
    toolkit.is.dev = false
  })

  it.each([false, true])('hands Ctrl+Shift+I to the page as the inspector chord (dev: %s)', (dev) => {
    toolkit.is.dev = dev
    const { press, scripts } = harness()
    const { prevented } = press({ code: 'KeyI', key: 'I', control: true, shift: true })
    // Chromium's DevTools accelerator never sees it; the renderer does.
    expect(prevented).toBe(true)
    expect(scripts).toHaveLength(1)
    const payload = JSON.parse(scripts[0]!.match(/new KeyboardEvent\('keydown', (\{.*\})\)/)![1]!) as Record<string, unknown>
    expect(payload).toMatchObject({ key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true, altKey: false })
  })

  it('leaves Ctrl+I alone — the page gets it directly', () => {
    const { press, scripts } = harness()
    expect(press({ code: 'KeyI', key: 'i', control: true }).prevented).toBe(false)
    expect(scripts).toHaveLength(0)
  })

  it('still swallows the other DevTools chord in production', () => {
    const { press, scripts } = harness()
    expect(press({ code: 'KeyI', key: 'i', alt: true, meta: true }).prevented).toBe(true)
    expect(scripts).toHaveLength(0)
  })
})
