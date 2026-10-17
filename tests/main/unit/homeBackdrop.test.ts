import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One private folder for this file: userData and the pictures picked from it.
const root = vi.hoisted(() => {
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { tmpdir: tmp } = require('node:os') as typeof import('node:os')
  const { join: j } = require('node:path') as typeof import('node:path')
  return mk(j(tmp(), 'vyotiq-home-backdrop-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => join(root, 'userData') }
}))

import {
  HOME_BACKDROP_MAX_BYTES,
  adoptHomeBackdrop,
  clearHomeBackdrop,
  readHomeBackdrop
} from '@main/appearance/homeBackdrop'

const picked = mkdtempSync(join(tmpdir(), 'vyotiq-home-backdrop-src-'))
const copies = (): string[] => {
  try {
    return readdirSync(join(root, 'userData', 'appearance'))
  } catch {
    return []
  }
}

beforeEach(async () => {
  await clearHomeBackdrop()
})

afterAll(() => {
  // Only the two folders this file made; the OS temp folder is shared.
  rmSync(root, { recursive: true, force: true })
  rmSync(picked, { recursive: true, force: true })
})

describe('home backdrop picture', () => {
  it('copies a picked picture in and reads it back as a data URL', async () => {
    const src = join(picked, 'sky.png')
    writeFileSync(src, Buffer.from([137, 80, 78, 71]))
    const res = await adoptHomeBackdrop(src)
    expect(res.ok).toBe(true)
    if (res.ok) expect(Number.isNaN(Date.parse(res.stamp))).toBe(false)
    expect(copies()).toEqual(['home-backdrop.png'])
    expect(await readHomeBackdrop()).toBe('data:image/png;base64,iVBORw==')
  })

  it('replaces the last picture instead of keeping both', async () => {
    writeFileSync(join(picked, 'a.png'), 'a')
    writeFileSync(join(picked, 'b.jpg'), 'b')
    await adoptHomeBackdrop(join(picked, 'a.png'))
    await adoptHomeBackdrop(join(picked, 'b.jpg'))
    expect(copies()).toEqual(['home-backdrop.jpg'])
    expect(await readHomeBackdrop()).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('refuses what is not a picture, and what is too large', async () => {
    writeFileSync(join(picked, 'notes.txt'), 'hello')
    const text = await adoptHomeBackdrop(join(picked, 'notes.txt'))
    expect(text.ok).toBe(false)
    writeFileSync(join(picked, 'huge.png'), Buffer.alloc(HOME_BACKDROP_MAX_BYTES + 1))
    const huge = await adoptHomeBackdrop(join(picked, 'huge.png'))
    expect(huge).toEqual({ ok: false, error: 'The picture is larger than 8 MB' })
    expect(copies()).toEqual([])
    expect(await readHomeBackdrop()).toBeNull()
  })

  it('leaves no copy behind once cleared', async () => {
    writeFileSync(join(picked, 'c.webp'), 'c')
    await adoptHomeBackdrop(join(picked, 'c.webp'))
    await clearHomeBackdrop()
    expect(copies()).toEqual([])
    expect(await readHomeBackdrop()).toBeNull()
  })
})
