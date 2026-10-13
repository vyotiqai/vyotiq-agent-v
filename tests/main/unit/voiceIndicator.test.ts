import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { badgeAssetFileFor, computeBadgeState, dockBadgeTextFor } from '@main/app/badgeState'
import { paintListeningDot } from '@main/app/trayDot'

const idle = { pendingApprovals: 0, pendingQuestions: 0, unreadNotifications: 0, activeRuns: 0 }

describe('the mic-on indicator (docs/voice-mode.md §13.8)', () => {
  it('the taskbar shows listening above unread and working, but under an agent that needs you', () => {
    expect(computeBadgeState({ ...idle, voiceListening: true, unreadNotifications: 3, activeRuns: 2 })).toEqual({
      kind: 'listening'
    })
    expect(computeBadgeState({ ...idle, voiceListening: true, pendingApprovals: 1 })).toEqual({ kind: 'needsyou', count: 1 })
    expect(computeBadgeState({ ...idle, voiceListening: false })).toEqual({ kind: 'idle' })
  })

  it('has its overlay asset and a dock text', () => {
    const file = badgeAssetFileFor({ kind: 'listening' })!
    expect(existsSync(join(process.cwd(), 'resources', 'badges', file))).toBe(true)
    expect(dockBadgeTextFor({ kind: 'listening' })).toBe('Mic')
  })

  it('the tray dot is painted in the bottom-right corner and leaves the rest alone', () => {
    const w = 16
    const h = 16
    const grey = new Uint8Array(w * h * 4).fill(0x80)
    const out = paintListeningDot(grey, w, h)
    const at = (x: number, y: number) => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4))
    expect(at(w - 3, h - 3)).toEqual([0x71, 0x71, 0xf8, 0xff])
    expect(at(1, 1)).toEqual([0x80, 0x80, 0x80, 0x80])
    expect(Array.from(grey.slice(0, 4))).toEqual([0x80, 0x80, 0x80, 0x80]) // input untouched
    expect(paintListeningDot(new Uint8Array(3), w, h)).toHaveLength(3)
  })
})
