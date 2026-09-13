/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '@renderer/lib/markdown/copyText'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'vyotiq')
})

describe('copyText', () => {
  it('uses native writeClipboard when present', async () => {
    const writeClipboard = vi.fn().mockReturnValue(true)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { writeClipboard }
    })
    vi.stubGlobal(
      'navigator',
      Object.assign({}, navigator, { clipboard: { writeText } })
    )

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeClipboard).toHaveBeenCalledWith('hello')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to Clipboard API when writeClipboard is absent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      'navigator',
      Object.assign({}, navigator, { clipboard: { writeText } })
    )

    await expect(copyText('from-api')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('from-api')
  })

  it('falls back to Clipboard API when writeClipboard throws', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        writeClipboard: () => {
          throw new Error('clipboard locked')
        }
      }
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      'navigator',
      Object.assign({}, navigator, { clipboard: { writeText } })
    )

    await expect(copyText('retry-throw')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('retry-throw')
  })

  it('falls back to Clipboard API when writeClipboard returns false', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { writeClipboard: () => false }
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal(
      'navigator',
      Object.assign({}, navigator, { clipboard: { writeText } })
    )

    await expect(copyText('retry')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('retry')
  })

  it('falls back to execCommand when Clipboard API fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal(
      'navigator',
      Object.assign({}, navigator, { clipboard: { writeText } })
    )
    const exec = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: exec
    })

    await expect(copyText('legacy')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    expect(document.body.querySelector('textarea')).toBeNull()
  })

  it('returns false when every path fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal(
      'navigator',
      Object.assign({}, navigator, { clipboard: { writeText } })
    )
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: () => false
    })

    await expect(copyText('nope')).resolves.toBe(false)
  })
})
