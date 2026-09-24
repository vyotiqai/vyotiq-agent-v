import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import type { ChatMessage } from '@shared/ipc'
import { executeTool } from '@main/agent/tools'
import { executeCreatePlan } from '@main/agent/tools/createPlan'
import {
  doneWhenNudgeText,
  executeCheckDoneWhen,
  readChecks,
  syncChecksAfterRewind,
  writeChecks
} from '@main/agent/doneWhenChecks'
import { isBuiltinAllowedInMode } from '@main/agent/tools/modePolicy'

const PLAN = [
  '# Fix the updater swap',
  '',
  '## Goal',
  '',
  'Stop the EBUSY failure when `swapStaged` renames the staged folder.',
  '',
  '## Scope',
  '',
  'In: `src/main/updater/swap.ts`. Out: the retry policy.',
  '',
  '## Steps',
  '',
  '1. Find what holds the handle in `src/main/updater/staging.ts`.',
  '2. Close it before the rename and run `pnpm vitest run tests/main/unit/updaterSwap.test.ts`.',
  '',
  '## Done when',
  '',
  '- [ ] The updater suite passes',
  '- [ ] No retry or sleep added around the swap',
  '',
  '## Risks',
  '',
  'A second watcher could hold the folder too.'
].join('\n')

describe('done-when checks', () => {
  let workspace: string
  let runDir: string

  afterEach(() => {
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  function setup(): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-checks-'))
    runDir = join(workspace, '.run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'contract.md'), '## Goal\n\nFix it\n\n## Done when\n\n- stub\n', 'utf8')
  }

  it('create_plan turns the Done when list into checks and lists them by id', () => {
    setup()
    const result = executeCreatePlan(workspace, { plan: PLAN }, { runDir })
    expect(result.ok).toBe(true)
    expect(readChecks(runDir).map((c) => [c.id, c.text, c.source, c.verdict])).toEqual([
      ['c1', 'The updater suite passes', 'plan', null],
      ['c2', 'No retry or sleep added around the swap', 'plan', null]
    ])
    const contract = readFileSync(join(runDir, 'contract.md'), 'utf8')
    expect(contract).toContain('- (c1) The updater suite passes')
    expect(contract).toContain('- (c2) No retry or sleep added around the swap')
    expect(contract).not.toContain('- stub')
    expect(result.content).toContain('c1 The updater suite passes')
    expect(result.content).toContain('check_done_when')
  })

  it('marks checks with evidence and says what is still open', () => {
    setup()
    executeCreatePlan(workspace, { plan: PLAN }, { runDir })
    const r = executeCheckDoneWhen(runDir, {
      checks: [{ id: 'c1', verdict: 'met', evidence: 'pnpm vitest run tests/main/unit/updaterSwap.test.ts — 6 passed' }]
    })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('c1 met. 1 of 2 checks met; still unmarked: c2.')
    expect(readChecks(runDir)[0]).toMatchObject({ verdict: 'met', evidence: expect.stringContaining('6 passed') })
    expect(doneWhenNudgeText(readChecks(runDir))).toBe(
      [
        'If you are finishing, first mark each done-when check with `check_done_when` — met or not met, each with the evidence you saw (the command and its result, the file, or why it is not met):',
        '- c2: No retry or sleep added around the swap',
        'If you are only pausing to ask the user something, leave them open and say so.'
      ].join('\n')
    )
  })

  it('refuses a verdict without evidence, an unknown id, or a run without checks', () => {
    setup()
    expect(executeCheckDoneWhen(runDir, { checks: [{ id: 'c1', verdict: 'met', evidence: 'x' }] }).content).toContain(
      'no done-when checks'
    )
    executeCreatePlan(workspace, { plan: PLAN }, { runDir })
    expect(executeCheckDoneWhen(runDir, { checks: [{ id: 'c1', verdict: 'met', evidence: ' ' }] }).ok).toBe(false)
    const unknown = executeCheckDoneWhen(runDir, { checks: [{ id: 'c9', verdict: 'met', evidence: 'x' }] })
    expect(unknown.ok).toBe(false)
    expect(unknown.content).toContain('No check has the id c9')
  })

  it('is dispatched as a tool, allowed in Agent and Plan but not Ask', async () => {
    setup()
    executeCreatePlan(workspace, { plan: PLAN }, { runDir })
    const out = await executeTool(
      'check_done_when',
      JSON.stringify({ checks: [{ id: 'c2', verdict: 'not_met', evidence: 'a retry is still in swap.ts:88' }] }),
      workspace,
      new AbortController().signal,
      { runDir }
    )
    expect(out.ok).toBe(true)
    expect(readChecks(runDir)[1]!.verdict).toBe('not_met')
    expect(isBuiltinAllowedInMode('agent', 'check_done_when')).toBe(true)
    expect(isBuiltinAllowedInMode('plan', 'check_done_when')).toBe(true)
    expect(isBuiltinAllowedInMode('ask', 'check_done_when')).toBe(false)
  })

  it('after a rewind, keeps only what the kept history made — brief checks stay, unmarked', () => {
    setup()
    writeChecks(runDir, [
      { id: 'c1', text: 'Brief check', source: 'brief', verdict: 'met', evidence: 'x', createdAt: '2026-09-24T09:00:00.000Z' }
    ])
    const plan = { id: 'p1', name: 'create_plan', arguments: JSON.stringify({ plan: PLAN }) }
    const mark = {
      id: 'm1',
      name: 'check_done_when',
      arguments: JSON.stringify({ checks: [{ id: 'c2', verdict: 'met', evidence: 'suite green' }] })
    }
    const kept: ChatMessage[] = [
      { role: 'user', content: 'Fix it', at: '2026-09-24T09:00:00.000Z' },
      { role: 'assistant', content: '', toolCalls: [plan] },
      { role: 'tool', content: 'ok', toolCallId: 'p1', toolName: 'create_plan', ok: true }
    ]
    // The verdict came after the rewind point: it is not replayed.
    syncChecksAfterRewind(runDir, kept)
    expect(readChecks(runDir).map((c) => [c.id, c.source, c.verdict])).toEqual([
      ['c1', 'brief', null],
      ['c2', 'plan', null],
      ['c3', 'plan', null]
    ])
    expect(readChecks(runDir)[1]!.createdAt).toBe('2026-09-24T09:00:00.000Z')
    syncChecksAfterRewind(runDir, [
      ...kept,
      { role: 'assistant', content: '', toolCalls: [mark] },
      { role: 'tool', content: 'ok', toolCallId: 'm1', toolName: 'check_done_when', ok: true }
    ])
    expect(readChecks(runDir)[1]!.verdict).toBe('met')
  })

  const planWith = (checks: string[]): string =>
    PLAN.replace(
      '- [ ] The updater suite passes\n- [ ] No retry or sleep added around the swap',
      checks.map((c) => `- [ ] ${c}`).join('\n')
    )

  it('never gives a dropped check’s id to a new one', () => {
    setup()
    executeCreatePlan(workspace, { plan: planWith(['A passes', 'B passes']) }, { runDir })
    expect(readChecks(runDir).map((c) => `${c.id} ${c.text}`)).toEqual(['c1 A passes', 'c2 B passes'])
    // B dropped: c2 goes with it…
    executeCreatePlan(workspace, { plan: planWith(['A passes']) }, { runDir })
    expect(readChecks(runDir).map((c) => c.id)).toEqual(['c1'])
    // …and a new check is c3, never c2 — the agent was told c2 meant B.
    executeCreatePlan(workspace, { plan: planWith(['A passes', 'C passes']) }, { runDir })
    expect(readChecks(runDir).map((c) => `${c.id} ${c.text}`)).toEqual(['c1 A passes', 'c3 C passes'])
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('- (c3) C passes')
  })

  it('a rewind past a plan rewrites the contract, so the next run is told the ids that exist', () => {
    setup()
    const call = (id: string, checks: string[]) => ({ id, name: 'create_plan', arguments: JSON.stringify({ plan: planWith(checks) }) })
    const first = call('p1', ['A passes', 'B passes'])
    const second = call('p2', ['A passes'])
    const third = call('p3', ['A passes', 'C passes'])
    for (const c of [first, second, third]) executeCreatePlan(workspace, JSON.parse(c.arguments), { runDir })
    const turn = (c: { id: string; name: string; arguments: string }): ChatMessage[] => [
      { role: 'assistant', content: '', toolCalls: [c] },
      { role: 'tool', content: 'ok', toolCallId: c.id, toolName: 'create_plan', ok: true }
    ]
    const user: ChatMessage = { role: 'user', content: 'Fix it', at: '2026-09-24T09:00:00.000Z' }

    // Replaying all three gives the same ids the run gave out: c3 stays C.
    syncChecksAfterRewind(runDir, [user, ...turn(first), ...turn(second), ...turn(third)])
    expect(readChecks(runDir).map((c) => `${c.id} ${c.text}`)).toEqual(['c1 A passes', 'c3 C passes'])

    // Rewound to before the third plan: C is gone from the checks and from the contract.
    syncChecksAfterRewind(runDir, [user, ...turn(first), ...turn(second)])
    expect(readChecks(runDir).map((c) => `${c.id} ${c.text}`)).toEqual(['c1 A passes'])
    let contract = readFileSync(join(runDir, 'contract.md'), 'utf8')
    expect(contract).toContain('- (c1) A passes')
    expect(contract).not.toContain('C passes')
    expect(contract).toContain('## Goal')

    // Rewound past every plan: no checks, and the contract's Done when is the default again.
    syncChecksAfterRewind(runDir, [user])
    expect(readChecks(runDir)).toEqual([])
    contract = readFileSync(join(runDir, 'contract.md'), 'utf8')
    expect(contract).not.toContain('(c1)')
    expect(contract).toContain('The goal above is satisfied')
  })
})
