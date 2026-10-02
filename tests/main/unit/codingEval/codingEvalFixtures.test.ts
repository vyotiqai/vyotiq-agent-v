/**
 * The coding-eval checkers must be meaningful: every untouched fixture FAILS,
 * every reference solution (solution/) PASSES, and the shortcuts a model might
 * take instead of the real fix are caught. No model, no Electron.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { runCheck } from '@main/agent/codingEval/check'
import { selfCheckFixtures } from '@main/agent/codingEval/runner'
import { applySolution, loadCodingTasks, matchesFilter, prepareWorkspace } from '@main/agent/codingEval/tasks'
import type { CodingEvalTask } from '@main/agent/codingEval/types'

const TASKS_ROOT = resolve(__dirname, '../../../../scripts/evals/coding')
const scratch = mkdtempSync(join(tmpdir(), 'vyotiq-codingeval-fixtures-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const tasks = loadCodingTasks(TASKS_ROOT)
const task = (id: string): CodingEvalTask => {
  const found = tasks.find((t) => t.id === id)
  if (!found) throw new Error(`no fixture ${id}`)
  return found
}

/** Reference solution, then `spoil` it, then score. Returns the failing check names. */
async function failingChecks(id: string, spoil: (ws: string) => void, answer = ''): Promise<string[]> {
  const t = task(id)
  const ws = prepareWorkspace(t, scratch)
  const reference = applySolution(t, ws)
  spoil(ws)
  const answerFile = join(scratch, `${id}-${Date.now()}-answer.md`)
  writeFileSync(answerFile, answer || reference)
  const result = await runCheck(t, ws, answerFile)
  expect(result.pass).toBe(false)
  return result.checks.filter((c) => !c.ok).map((c) => c.name)
}

const edit = (ws: string, rel: string, from: string, to: string): void => {
  const path = join(ws, rel)
  const text = readFileSync(path, 'utf8')
  if (!text.includes(from)) throw new Error(`${rel} has no ${from}`)
  writeFileSync(path, text.replace(from, to))
}

describe('coding eval fixtures', () => {
  it('has 8-12 well-formed tasks covering the required categories', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(8)
    expect(tasks.length).toBeLessThanOrEqual(12)
    const categories = new Set(tasks.map((t) => t.category))
    for (const c of ['bug-fix', 'feature', 'refactor', 'multi-file-rename', 'read-only-question', 'repo-instructions', 'protected-file', 'failing-command-recovery']) {
      expect(categories.has(c), c).toBe(true)
    }
    expect(tasks.find((t) => t.mode === 'ask')?.id).toBe('ask-server-port')
    expect(matchesFilter('fix-paginate', 'nope, PAGIN')).toBe(true)
    expect(matchesFilter('fix-paginate', 'nope')).toBe(false)
  })

  it('the .fixture suffix is stripped on copy (AGENTS.md reaches the workspace)', () => {
    const ws = prepareWorkspace(task('follow-agents-md'), scratch)
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain('CHANGELOG.md')
  })

  it('every untouched fixture fails and every reference solution passes', async () => {
    const results = await selfCheckFixtures(tasks, { scratchParent: scratch, concurrency: 4 })
    const bad = results.filter((r) => !r.ok).map((r) => `${r.taskId}: ${r.problem}`)
    expect(bad).toEqual([])
    expect(results).toHaveLength(tasks.length)
  }, 240_000)

  it('catches editing the tests instead of the bug', async () => {
    const failed = await failingChecks('fix-paginate', (ws) => {
      edit(ws, 'src/paginate.js', 'start + size)', 'start + size - 1)')
      edit(ws, 'test/paginate.test.js', "['a', 'b', 'c']", "['a', 'b']")
    })
    expect(failed).toContain('test/ unchanged')
  }, 60_000)

  it('catches editing the protected vendor file', async () => {
    const failed = await failingChecks('protected-vendor', (ws) => {
      edit(ws, 'src/users.js', ', { attempts: MAX_ATTEMPTS }', '')
      edit(ws, 'src/vendor/retry.js', 'attempts: 3', 'attempts: 5')
    })
    expect(failed).toEqual(['src/vendor/ unchanged'])
  }, 60_000)

  it('catches dropping the bad product instead of fixing it', async () => {
    const failed = await failingChecks('recover-build', (ws) => {
      const path = join(ws, 'data', 'products.json')
      const products = JSON.parse(readFileSync(path, 'utf8')) as Array<{ sku: string }>
      writeFileSync(path, JSON.stringify(products.filter((p) => p.sku !== 'BCD-011')))
      spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ws })
    })
    expect(failed).toContain('BCD-011 priced at 1250 cents')
  }, 60_000)

  it('catches a refactor that adds the helper but keeps the duplication', async () => {
    const failed = await failingChecks('refactor-pricing', (ws) => {
      const original = readFileSync(join(task('refactor-pricing').dir, 'repo', 'src', 'pricing.js'), 'utf8')
      writeFileSync(
        join(ws, 'src', 'pricing.js'),
        `${original}\nexport function applyDiscount(base, rate) {\n  return Math.round((base - base * rate) * 100) / 100\n}\n`
      )
    })
    expect(failed).toEqual(expect.arrayContaining(['rounding logic appears once', 'each price function calls applyDiscount']))
  }, 60_000)

  it('catches weak tests through surviving mutants', async () => {
    const failed = await failingChecks('write-tests-duration', (ws) => {
      writeFileSync(
        join(ws, 'test', 'parseDuration.test.js'),
        "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { parseDuration } from '../src/parseDuration.js'\n\ntest('hours', () => {\n  assert.equal(parseDuration('2h'), 7200)\n})\n"
      )
    })
    expect(failed).toEqual(['every mutant is caught by the tests'])
  }, 120_000)

  it('catches ignoring AGENTS.md (no changelog bullet)', async () => {
    const failed = await failingChecks('follow-agents-md', (ws) => {
      edit(ws, 'CHANGELOG.md', '- clamp: add clamp(value, min, max), throwing RangeError when min > max.\n\n', '')
    })
    expect(failed).toEqual(['CHANGELOG.md has a `- clamp:` bullet under Unreleased'])
  }, 60_000)

  it('catches a wrong Ask answer and an Ask run that edits files', async () => {
    const wrong = await failingChecks('ask-server-port', () => {}, 'The server listens on port 3000 (see README); set PORT to change it.')
    expect(wrong).toEqual(['answer names port 8443', 'answer names VY_LISTEN_PORT'])
    const edited = await failingChecks('ask-server-port', (ws) => {
      edit(ws, 'README.md', 'port 3000', 'port 8443')
    })
    expect(edited).toEqual(['workspace untouched'])
  }, 60_000)
})
