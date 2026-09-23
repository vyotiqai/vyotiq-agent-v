import { describe, expect, it } from 'vitest'
import { namedGitBranch } from '@shared/utils/gitBranch'
import {
  runTitle,
  runTooltip,
  runSearchText,
  stripGoalMarkdown,
  instanceDisplayTitle,
  uniqueInstanceTitles,
  pathScopeLabel
} from '@renderer/app/navigator/runTitle'
import type { RunSummary } from '@shared/ipc'

describe('namedGitBranch', () => {
  it('maps empty and HEAD to null', () => {
    expect(namedGitBranch(null)).toBeNull()
    expect(namedGitBranch('')).toBeNull()
    expect(namedGitBranch('  ')).toBeNull()
    expect(namedGitBranch('HEAD')).toBeNull()
    expect(namedGitBranch(' HEAD ')).toBeNull()
  })

  it('keeps real branch names', () => {
    expect(namedGitBranch('main')).toBe('main')
    expect(namedGitBranch(' feature/x ')).toBe('feature/x')
  })
})

describe('runTitle', () => {
  function run(goal: string | undefined, extra?: Partial<RunSummary>): RunSummary {
    return {
      runId: 'abcdefgh-1234',
      goal,
      status: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...extra
    }
  }

  it('strips markdown headings from sidebar titles', () => {
    expect(stripGoalMarkdown('### You may launch agents')).toBe('You may launch agents')
    expect(runTitle(run('### You may launch agents now please'))).toBe(
      'You may launch agents now please'
    )
    expect(runTooltip(run('### You may launch agents')).startsWith('You may')).toBe(true)
  })

  it('does not hard-slice long parent titles (CSS truncate + tooltip handle overflow)', () => {
    const long =
      'You may launch multiple parallel agents concurrently and keep going forever'
    expect(runTitle(run(long))).toBe(long)
    expect(runTooltip(run(long))).toBe(long)
  })

  it('strips spawn boilerplate from parent titles', () => {
    expect(
      runTitle(
        run('Spawn multiple parallel instances for: Audit and check the entire codebase')
      )
    ).toBe('Audit and check the entire codebase')
  })

  it('falls back to runId when goal missing', () => {
    expect(runTitle(run(undefined))).toBe('abcdefgh')
  })

  it('uses compact partition titles for inline instances (no Instance · prefix)', () => {
    const goal =
      'Audit-partition B (LLM client & config) of the node ESM project at workspace root. Read EVERY file'
    const inst = run(goal, { inlineInstance: true, parentRunId: 'parent-1' })
    expect(instanceDisplayTitle(goal, inst.runId)).toBe(
      'Audit-partition B (LLM client & config)'
    )
    expect(runTitle(inst)).toBe('Audit-partition B (LLM client & config)')
    expect(runTooltip(inst).startsWith('Instance ·')).toBe(true)
  })

  it('prefers path_scope over shared preamble for instances', () => {
    const goal = 'Round-4 evidence-based audit of the whole tree'
    const inst = run(goal, {
      inlineInstance: true,
      parentRunId: 'parent-1',
      pathScope: ['src/tools/', 'src/utils/']
    })
    expect(runTitle(inst)).toBe('src/tools')
    expect(pathScopeLabel(['src/tools/'])).toBe('src/tools')
  })

  it('strips AUDIT SCOPE dumps into a compact path label', () => {
    const goal = 'AUDIT SCOPE: docs/**, README.md, package.json, and more noise'
    expect(instanceDisplayTitle(goal, 'abcdefgh-1234')).toBe('docs/**')
  })

  it('disambiguates identical sibling instance titles with path_scope', () => {
    const siblings: RunSummary[] = [
      run('Round-4 evidence-based audit', {
        runId: 'aaa11111-xxxx',
        inlineInstance: true,
        parentRunId: 'p',
        pathScope: ['docs/**']
      }),
      run('Round-4 evidence-based audit', {
        runId: 'bbb22222-xxxx',
        inlineInstance: true,
        parentRunId: 'p',
        pathScope: ['src/tools/']
      })
    ]
    const titles = uniqueInstanceTitles(siblings)
    expect(titles.get('aaa11111-xxxx')).toBe('docs/**')
    expect(titles.get('bbb22222-xxxx')).toBe('src/tools')
  })

  it('search text matches stripped display title', () => {
    const goal = '### Fix login flow'
    expect(runSearchText(run(goal))).toBe('fix login flow')
    expect(runSearchText(run(goal)).includes('fix login')).toBe(true)
  })
})
