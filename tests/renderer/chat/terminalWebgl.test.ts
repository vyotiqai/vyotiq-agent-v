import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

const onContextLoss = vi.fn()
const dispose = vi.fn()
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddon(this: Record<string, unknown>) {
    this.onContextLoss = onContextLoss
    this.dispose = dispose
  })
}))

import { loadWebglRenderer } from '@renderer/features/chat/components/TerminalPanel'

describe('loadWebglRenderer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    onContextLoss.mockClear()
    dispose.mockClear()
  })

  it('leaves the DOM renderer drawing where there is no WebGL', () => {
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    const loadAddon = vi.fn()
    expect(loadWebglRenderer({ loadAddon } as unknown as Terminal)).toBeNull()
    expect(loadAddon).not.toHaveBeenCalled()
  })

  it('leaves the DOM renderer drawing when WebGL cannot start', () => {
    vi.stubGlobal('WebGL2RenderingContext', function WebGL2RenderingContext() {})
    const loadAddon = vi.fn(() => {
      throw new Error('could not create a WebGL2 context')
    })
    expect(loadWebglRenderer({ loadAddon } as unknown as Terminal)).toBeNull()
  })

  it('draws with WebGL, and lets go of it when the GPU context is lost', () => {
    vi.stubGlobal('WebGL2RenderingContext', function WebGL2RenderingContext() {})
    const loadAddon = vi.fn()
    const addon = loadWebglRenderer({ loadAddon } as unknown as Terminal)
    expect(addon).not.toBeNull()
    expect(loadAddon).toHaveBeenCalledWith(addon)
    const lost = onContextLoss.mock.calls[0]?.[0] as () => void
    lost()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
