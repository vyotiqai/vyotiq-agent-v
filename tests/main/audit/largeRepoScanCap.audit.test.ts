/**
 * Live grep/glob/search walks honor an injectable scan cap.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolGrep } from '@main/agent/tools/grep'
import { toolGlob } from '@main/agent/tools/glob'
import { toolSearch } from '@main/agent/tools/search'

describe('audit: large repo scans honor scan caps', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
  })

  function buildTree(fileCount: number): string {
    const root = join(tmpdir(), `vyotiq-audit-${process.pid}-${fileCount}-${Date.now()}`)
    roots.push(root)
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    for (let i = 0; i < fileCount; i++) {
      const dir = join(root, `pkg${Math.floor(i / 100)}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `file${i}.ts`), `export const TARGET_${i} = 'needle'\n`, 'utf8')
    }
    return root
  }

  it('emits a grep scan-cap notice when the live walk is capped', async () => {
    const root = buildTree(8)
    const out = await toolGrep(root, 'TARGET_7', { scanCap: 3 })
    expect(out).toMatch(/scan cap 3/)
  })

  it('emits a glob scan-cap notice when the live walk is capped', async () => {
    const root = buildTree(8)
    const out = await toolGlob(root, '**/*.ts', undefined, undefined, 3)
    expect(out).toMatch(/scan cap 3/)
  })

  it('emits a search scan-cap notice when the live walk is capped', async () => {
    const root = buildTree(8)
    const out = await toolSearch(root, 'TARGET_7', undefined, undefined, false, 3)
    expect(out).toMatch(/scan cap 3/)
  })
})
