import { describe, expect, it } from 'vitest'
import { inQuietHours } from '../../src/shared/ipc/schemas/settings'

const at = (h: number, m = 0): Date => new Date(2026, 9, 8, h, m)

describe('inQuietHours', () => {
  it('is never quiet while off', () => {
    expect(inQuietHours({ enabled: false, start: '00:00', end: '23:59' }, at(12))).toBe(false)
  })

  it('reads a same-day window, start inclusive and end exclusive', () => {
    const q = { enabled: true, start: '09:00', end: '17:00' }
    expect(inQuietHours(q, at(9))).toBe(true)
    expect(inQuietHours(q, at(16, 59))).toBe(true)
    expect(inQuietHours(q, at(17))).toBe(false)
    expect(inQuietHours(q, at(8, 59))).toBe(false)
  })

  it('reads a window that runs past midnight', () => {
    const q = { enabled: true, start: '22:00', end: '07:00' }
    expect(inQuietHours(q, at(23))).toBe(true)
    expect(inQuietHours(q, at(3))).toBe(true)
    expect(inQuietHours(q, at(7))).toBe(false)
    expect(inQuietHours(q, at(12))).toBe(false)
  })

  it('treats an empty window as never', () => {
    expect(inQuietHours({ enabled: true, start: '08:00', end: '08:00' }, at(8))).toBe(false)
  })
})
