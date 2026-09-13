import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  extractProposedHarnessBody,
  upsertReceiptNotes,
  previewHarnessApply,
  applyHarnessProposal,
  harnessValidate,
  proposalAttemptsGateTamper,
  harnessGateSourcesDirty,
  harnessGateDirtyCheck,
  HARNESS_EVAL_TESTS,
  HARNESS_GATE_SOURCE_PATHS,
  RECEIPT_NOTES_HEADING,
  workspaceHasEditableHarness
} from '@main/agent/harnessApply'

describe('harnessApply', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-happly-${process.pid}-${Date.now()}`)
    mkdirSync(join(workspace, 'resources', 'harness'), { recursive: true })
    writeFileSync(
      join(workspace, 'resources', 'harness', 'default.md'),
      '# Agent V\n\n## Work style\n\nBe careful.\n',
      'utf8'
    )
    vi.spyOn(harnessValidate, 'run').mockResolvedValue({ ok: true, output: 'tests passed' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('extracts proposed harness body from fenced block', () => {
    const md = [
      '# Proposal',
      '',
      '## Proposed harness body',
      '',
      '```markdown',
      '# New harness',
      '',
      'Hello',
      '```',
      ''
    ].join('\n')
    expect(extractProposedHarnessBody(md)).toBe('# New harness\n\nHello\n')
  })

  it('upserts receipt notes section idempotently', () => {
    const base = '# Agent V\n\n## Work style\n\nx\n'
    const once = upsertReceiptNotes(base, ['Mined 1'], ['- tip'])
    expect(once).toContain(RECEIPT_NOTES_HEADING)
    expect(once).toContain('Mined 1')
    const twice = upsertReceiptNotes(once, ['Mined 2'], ['- tip2'])
    expect(twice.match(/## Receipt review notes/g)?.length).toBe(1)
    expect(twice).toContain('Mined 2')
    expect(twice).not.toContain('Mined 1')
  })

  it('previews and applies with confirm', async () => {
    const proposed = upsertReceiptNotes(
      readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8'),
      ['evidence'],
      ['- do thing']
    )
    const proposals = join(workspace, 'resources', 'harness', 'proposals')
    mkdirSync(proposals, { recursive: true })
    const proposalPath = join(proposals, '2026-07-30T00-00-00-abc.md')
    writeFileSync(
      proposalPath,
      ['# Prop', '', '## Proposed harness body', '', '```markdown', proposed.trimEnd(), '```', ''].join(
        '\n'
      ),
      'utf8'
    )

    const preview = previewHarnessApply(workspace, proposalPath)
    expect(preview.changed).toBe(true)

    await expect(
      applyHarnessProposal(workspace, { proposalPath, confirm: false })
    ).rejects.toThrow(/confirm/)

    const result = await applyHarnessProposal(workspace, { proposalPath, confirm: true })
    expect(result.applied).toBe(true)
    expect(result.reverted).toBe(false)
    expect(readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')).toContain(
      'evidence'
    )
  })

  it('reverts when validation fails', async () => {
    vi.mocked(harnessValidate.run).mockResolvedValue({ ok: false, output: 'FAIL' })

    const original = readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')
    const proposed = `${original}\n\n## Receipt review notes\n\n- bad\n`
    const proposals = join(workspace, 'resources', 'harness', 'proposals')
    mkdirSync(proposals, { recursive: true })
    const proposalPath = join(proposals, 'fail.md')
    writeFileSync(
      proposalPath,
      ['## Proposed harness body', '', '```markdown', proposed.trimEnd(), '```'].join('\n'),
      'utf8'
    )

    const result = await applyHarnessProposal(workspace, { proposalPath, confirm: true })
    expect(result.applied).toBe(false)
    expect(result.reverted).toBe(true)
    expect(readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')).toBe(
      original
    )
  })

  it('pins HARNESS_EVAL_TESTS to the required gate modules', () => {
    const required = [
      'tests/main/unit/harness.test.ts',
      'tests/main/unit/toolsSchema.test.ts',
      'tests/main/unit/modePolicy.test.ts',
      'tests/main/unit/loopPolicy.test.ts',
      'tests/main/unit/agentLoopSafety.test.ts',
      'tests/main/unit/loopPolicySafety.test.ts',
      'tests/main/unit/runReceipt.test.ts',
      'tests/main/unit/harnessReview.test.ts',
      'tests/main/unit/harnessApply.test.ts',
      'tests/main/unit/harnessHeldOutEval.test.ts'
    ]
    for (const file of required) {
      expect(HARNESS_EVAL_TESTS).toContain(file)
    }
    expect(HARNESS_EVAL_TESTS.length).toBe(required.length)
  })

  it('includes held-out grader in gate source paths', () => {
    expect(HARNESS_GATE_SOURCE_PATHS).toContain('src/main/agent/harnessHeldOutEval.ts')
  })

  it('detects and refuses gate-tamper proposals', async () => {
    expect(
      proposalAttemptsGateTamper('Please delete HARNESS_EVAL_TESTS and skip vitest')
    ).toBe(true)
    expect(proposalAttemptsGateTamper('# Agent V\n\nBe careful.\n')).toBe(false)

    const original = readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')
    const proposed = `${original}\n\n## Notes\n\nDisable HARNESS_EVAL_TESTS entirely.\n`
    const proposals = join(workspace, 'resources', 'harness', 'proposals')
    mkdirSync(proposals, { recursive: true })
    const proposalPath = join(proposals, 'tamper.md')
    writeFileSync(
      proposalPath,
      ['## Proposed harness body', '', '```markdown', proposed.trimEnd(), '```'].join('\n'),
      'utf8'
    )

    const result = await applyHarnessProposal(workspace, { proposalPath, confirm: true })
    expect(result.applied).toBe(false)
    expect(result.reverted).toBe(false)
    expect(result.validationOk).toBe(false)
    expect(result.validationOutput).toMatch(/Refused|hollow/i)
    expect(readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')).toBe(
      original
    )
  })

  it('includes harnessApply.ts in gate source paths', () => {
    expect(HARNESS_GATE_SOURCE_PATHS).toContain('src/main/agent/harnessApply.ts')
    for (const file of HARNESS_EVAL_TESTS) {
      expect(HARNESS_GATE_SOURCE_PATHS).toContain(file)
    }
  })

  it('skips dirty-gate check when workspace is not a git repo', async () => {
    const status = await harnessGateSourcesDirty(workspace)
    expect(status.checked).toBe(false)
    expect(status.dirtyPaths).toEqual([])
    expect(status.error).toBeUndefined()
  })

  it('refuses apply when gate sources are dirty', async () => {
    vi.spyOn(harnessGateDirtyCheck, 'run').mockResolvedValue({
      checked: true,
      dirtyPaths: ['src/main/agent/harnessApply.ts']
    })

    const original = readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')
    const proposed = `${original}\n\n## Receipt review notes\n\n- ok\n`
    const proposals = join(workspace, 'resources', 'harness', 'proposals')
    mkdirSync(proposals, { recursive: true })
    const proposalPath = join(proposals, 'dirty.md')
    writeFileSync(
      proposalPath,
      ['## Proposed harness body', '', '```markdown', proposed.trimEnd(), '```'].join('\n'),
      'utf8'
    )

    const result = await applyHarnessProposal(workspace, { proposalPath, confirm: true })
    expect(result.applied).toBe(false)
    expect(result.validationOk).toBe(false)
    expect(result.validationOutput).toMatch(/uncommitted changes/i)
    expect(readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')).toBe(
      original
    )
  })

  it('refuses apply when git status fails in a git workspace (fail-closed)', async () => {
    vi.spyOn(harnessGateDirtyCheck, 'run').mockResolvedValue({
      checked: true,
      dirtyPaths: [],
      error: 'git status failed while checking harness apply gate sources: boom'
    })

    const original = readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')
    const proposed = `${original}\n\n## Receipt review notes\n\n- ok\n`
    const proposals = join(workspace, 'resources', 'harness', 'proposals')
    mkdirSync(proposals, { recursive: true })
    const proposalPath = join(proposals, 'git-fail.md')
    writeFileSync(
      proposalPath,
      ['## Proposed harness body', '', '```markdown', proposed.trimEnd(), '```'].join('\n'),
      'utf8'
    )

    const result = await applyHarnessProposal(workspace, { proposalPath, confirm: true })
    expect(result.applied).toBe(false)
    expect(result.validationOk).toBe(false)
    expect(result.validationOutput).toMatch(/could not verify/i)
    expect(result.validationOutput).toMatch(/git status failed/i)
    expect(readFileSync(join(workspace, 'resources', 'harness', 'default.md'), 'utf8')).toBe(
      original
    )
  })

  it('previewHarnessApply throws when workspace has no editable harness', () => {
    const plain = join(tmpdir(), `vyotiq-happly-plain-${process.pid}-${Date.now()}`)
    mkdirSync(plain, { recursive: true })
    expect(() =>
      previewHarnessApply(plain, 'resources/harness/proposals/missing.md')
    ).toThrow(/no editable harness/i)
    rmSync(plain, { recursive: true, force: true })
  })

  it('workspaceHasEditableHarness returns false for missing workspace roots', () => {
    const missing = join(tmpdir(), `vyotiq-happly-missing-${process.pid}-${Date.now()}`)
    expect(existsSync(missing)).toBe(false)
    expect(workspaceHasEditableHarness(missing)).toBe(false)
  })
})
