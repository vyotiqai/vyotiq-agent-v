/**
 * Index-backed grep/glob integration e2e — real tools + the SQLite code index, small tree (~200 files).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  closeCodeIndexStore,
  disposeCodeIndexWorkspace,
  ensureCodeIndexSynced,
  getOrOpenCodeIndexStore
} from '@main/agent/codeindex'
import { toolGrep } from '@main/agent/tools/grep'
import { toolGlob } from '@main/agent/tools/glob'

const MARKER = 'VYOTIQ_E2E_INDEX_MARKER_ZZZ'
const FILE_COUNT = 200

function buildTree(root: string): string {
  mkdirSync(root, { recursive: true })
  for (let i = 0; i < FILE_COUNT; i++) {
    const dir = join(root, `pkg${Math.floor(i / 50)}`)
    mkdirSync(dir, { recursive: true })
    const body =
      i === FILE_COUNT - 1
        ? `export const ${MARKER} = true\n`
        : `export const filler${i} = ${i}\n`
    writeFileSync(join(dir, `file${i}.ts`), body, 'utf8')
  }
  return join(root, `pkg${Math.floor((FILE_COUNT - 1) / 50)}`, `file${FILE_COUNT - 1}.ts`)
    .slice(root.length + 1)
    .replace(/\\/g, '/')
}

describe('e2e: large repo index integration', () => {
  let workspace: string
  let markerRel: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-index-e2e-ws-${process.pid}-${Date.now()}`)
    markerRel = buildTree(workspace)
  })

  afterEach(() => {
    disposeCodeIndexWorkspace(workspace)
    closeCodeIndexStore(workspace)
    if (existsSync(workspace)) {
      try {
        rmSync(workspace, { recursive: true, force: true })
      } catch {
        /* windows sqlite lock */
      }
    }
  })

  it('index-backed grep finds marker with index=trigram footer', async () => {
    const { sync } = await ensureCodeIndexSynced(workspace)
    expect(sync?.syncComplete).toBe(true)
    expect(getOrOpenCodeIndexStore(workspace).getStatus().ready).toBe(true)

    const out = await toolGrep(workspace, MARKER)
    expect(out).toContain(MARKER)
    expect(out).toContain(markerRel)
    expect(out).toMatch(/index=trigram/)
    expect(out).not.toMatch(/sync in progress/i)
  }, 60_000)

  it('index-backed glob lists marker file with index=trigram footer', async () => {
    const { sync } = await ensureCodeIndexSynced(workspace)
    expect(sync?.syncComplete).toBe(true)

    const out = await toolGlob(workspace, `**/file${FILE_COUNT - 1}.ts`)
    expect(out).toContain(markerRel)
    expect(out).toMatch(/index=trigram/)
    expect(out).not.toMatch(/scan cap/i)
  }, 60_000)

  it('surfaces in-progress notice when syncComplete is false', async () => {
    const { sync } = await ensureCodeIndexSynced(workspace)
    expect(sync?.syncComplete).toBe(true)
    const store = getOrOpenCodeIndexStore(workspace)
    store.setMeta('syncComplete', 'false')

    const grepOut = await toolGrep(workspace, MARKER)
    expect(grepOut).toMatch(/index sync in progress/)
    expect(grepOut).toMatch(/index=trigram/)

    const globOut = await toolGlob(workspace, '**/*.ts')
    expect(globOut).toMatch(/index sync in progress/)
    expect(globOut).toMatch(/index=trigram/)
  }, 60_000)
})
