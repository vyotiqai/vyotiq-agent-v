import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * git_apply path_scope. A patch names its own targets, so the guard has to read
 * them out of the patch text — and a patch that names none (git's binary format
 * encodes paths inside base85 blocks) must fail closed rather than pass scope
 * on an empty list.
 *
 * These exercise the dispatch guards, not the handler: the temp workspace is
 * not a git repo, so a call that clears the guards fails with
 * 'Not a git repository' and one that does not never reaches that far.
 */

const tempRoot = mkdtempSync(join(tmpdir(), 'vyotiq-git-apply-scope-'))
vi.mock('electron', () => ({
  app: { getPath: () => tempRoot },
  BrowserWindow: class {}
}))

import { executeTool } from '@main/agent/tools'
import { createRun } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'
import {
  beginWriteCheckpoint,
  discardWriteCheckpoint,
  resetWriteCheckpointsForTests
} from '@main/agent/checkpoints'
import { canGit } from '../../helpers/canGit'

const root = join(tempRoot, 'ws')
mkdirSync(root, { recursive: true })

const roots: string[] = [root]
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function scopedRun(name: string, pathScope: string[]): string {
  const workspace = mkdtempSync(join(tempRoot, `${name}-`))
  roots.push(workspace)
  const runId = `child-${name}`
  createRun(workspace, runId, 'scoped child', {
    inlineInstance: true,
    parentRunId: 'parent',
    pathScope
  })
  return resolveRunDir(workspace, runId)
}

function apply(
  patch: string,
  context: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  return executeTool(
    'git_apply',
    JSON.stringify({ patch, ...extra }),
    root,
    new AbortController().signal,
    context as never
  )
}

const inScopePatch = [
  'diff --git a/src/allowed/a.ts b/src/allowed/a.ts',
  '--- a/src/allowed/a.ts',
  '+++ b/src/allowed/a.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b'
].join('\n')

const outOfScopePatch = [
  'diff --git a/src/other/b.ts b/src/other/b.ts',
  '--- a/src/other/b.ts',
  '+++ b/src/other/b.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b'
].join('\n')

const binaryPatch = [
  'diff --git a/secrets.env b/secrets.env',
  'index 1234567..89abcde 100644',
  'GIT binary patch',
  'literal 12',
  'KcmZQzU?ajOR)bKUD+wsQPAeIUl',
  ''
].join('\n')

const headerlessPatch = ['@@ -1 +1 @@', '-a', '+b'].join('\n')

describe('git_apply inline path_scope', () => {
  it('denies a patch that writes outside the scope', async () => {
    const result = await apply(outOfScopePatch, {
      runDir: scopedRun('oos', ['src/allowed']),
      inlineInstance: true
    })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside this instance path_scope/)
  })

  it('denies a GIT binary patch instead of passing scope on an empty path list', async () => {
    const result = await apply(binaryPatch, {
      runDir: scopedRun('bin', ['src/allowed']),
      inlineInstance: true
    })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Binary GIT patches are denied/)
  })

  it('denies a non-empty patch that names no paths', async () => {
    const result = await apply(headerlessPatch, {
      runDir: scopedRun('bare', ['src/allowed']),
      inlineInstance: true
    })
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/names no paths to check against path_scope/)
  })

  it('lets an in-scope patch through to the handler', async () => {
    const result = await apply(inScopePatch, {
      runDir: scopedRun('in', ['src/allowed']),
      inlineInstance: true
    })
    // Cleared the guards; the temp workspace is not a repo, so it stops here.
    expect(result.content).toBe('Not a git repository')
  })

  it('denies the retired .vyotiq/agents/ data root', async () => {
    const result = await apply(
      [
        'diff --git a/.vyotiq/agents/old/data.json b/.vyotiq/agents/old/data.json',
        '--- a/.vyotiq/agents/old/data.json',
        '+++ b/.vyotiq/agents/old/data.json',
        '@@ -1 +1 @@',
        '-a',
        '+b'
      ].join('\n'),
      {}
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/retired per-profile data/)
  })

  it('leaves unscoped runs and check runs alone', async () => {
    const unscoped = await apply(binaryPatch, {})
    expect(unscoped.content).toBe('Not a git repository')

    // check: true writes nothing, so the guard stays out of it exactly as it
    // was for the edit tools.
    const checkRun = await apply(
      binaryPatch,
      { runDir: scopedRun('check', ['src/allowed']), inlineInstance: true },
      { check: true }
    )
    expect(checkRun.content).toBe('Not a git repository')
  })
})

/**
 * `check: true` runs `git apply --check` (src/main/git/git.ts:300), a dry run:
 * it parses the patch against the working tree and writes nothing. The handler
 * therefore takes no write checkpoint for it (gitGithubTools.ts:82), which is
 * what keeps `otherWriteCount` — the only signal the verification tracker has
 * for a non-edit writer (verification.ts:86) — still on a write that never
 * happened. Counting a dry run would demand a check of files it did not touch.
 */
describe.skipIf(!canGit)('git_apply check runs', () => {
  let repo: string
  let runDir: string

  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1 +1 @@',
    '-hello',
    '+patched',
    ''
  ].join('\n')

  beforeEach(() => {
    resetWriteCheckpointsForTests()
    repo = mkdtempSync(join(tempRoot, 'repo-'))
    runDir = mkdtempSync(join(tempRoot, 'run-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf8')
  })

  afterEach(() => {
    resetWriteCheckpointsForTests()
    rmSync(repo, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  const run = (extra: Record<string, unknown>) =>
    executeTool(
      'git_apply',
      JSON.stringify({ patch, ...extra }),
      repo,
      new AbortController().signal,
      { runDir } as never
    )

  it('leaves the workspace alone and counts no other write', async () => {
    const cp = beginWriteCheckpoint(runDir, repo)
    const result = await run({ check: true })
    expect(result.ok, result.content).toBe(true)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\n')
    // A counted dry run would make the turn-end gate demand a check of work
    // that was never applied.
    expect(cp.otherWriteCount).toBe(0)
    discardWriteCheckpoint(runDir)
  })

  // The contrast: the same patch without `check` does land, and the non-edit
  // write the verification tracker reads is counted — so the count above is a
  // real zero, not a counter that never moves.
  it('counts the same patch once it actually applies', async () => {
    const cp = beginWriteCheckpoint(runDir, repo)
    const result = await run({})
    expect(result.ok, result.content).toBe(true)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('patched\n')
    expect(cp.otherWriteCount).toBe(1)
    discardWriteCheckpoint(runDir)
  })
})
