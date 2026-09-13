import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs'
import { join, relative, isAbsolute, dirname } from 'path'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { HarnessApplyResult, HarnessPreviewApplyResult } from '../../shared/ipc'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
import { atomicWriteFile } from '../storage/atomicWrite'
import { realpathIfExists, resolveInsideWorkspace } from '../workspace/safePath'
import { WORKSPACE_HARNESS_REL, workspaceHarnessPath, HARNESS_PROPOSALS_REL, HARNESS_BACKUP_REL } from './harness'
import { sanitizedTerminalEnv } from './tools/terminal'

const execFile = promisify(execFileCb)

export const RECEIPT_NOTES_HEADING = '## Receipt review notes'

/** Apply mutates only this relative path; evaluator / gate changes are PR-only. */
export const HARNESS_APPLY_SURFACE_NOTE =
  '`/harness-apply` writes only the canonical plain-text `resources/harness/default.md`. Changing evaluator code, `HARNESS_EVAL_TESTS`, held-out fixtures (`harnessHeldOutEval.ts`), or gate unit tests requires a normal PR — not harness-apply.'

/**
 * Fixed vitest subset used as the harness-apply gate.
 * Keep this list stable; shrinking it without a PR is a reward-hacking risk.
 */
export const HARNESS_EVAL_TESTS = [
  'tests/main/unit/harness.test.ts',
  'tests/main/unit/toolsSchema.test.ts',
  'tests/main/unit/modePolicy.test.ts',
  'tests/main/unit/loopPolicy.test.ts',
  'tests/main/unit/agentLoopSafety.test.ts',
  'tests/main/unit/loopPolicySafety.test.ts',
  'tests/main/unit/runReceipt.test.ts',
  'tests/main/unit/harnessReview.test.ts',
  'tests/main/unit/harnessApply.test.ts',
  /** Frozen held-out grader — never auto-applies; edit cases only via PR. */
  'tests/main/unit/harnessHeldOutEval.test.ts'
] as const

/** Patterns that attempt to disable or hollow out the apply gate inside a proposed harness body. */
const GATE_TAMPER_RE =
  /(?:\bHARNESS_EVAL_TESTS\b|\bharnessValidate\b|\brunHarnessEvaluators\b)[\s\S]{0,40}\b(delete|remove|empty|skip|disable)\b|\b(delete|remove|empty|skip|disable)\b[\s\S]{0,40}(?:\bHARNESS_EVAL_TESTS\b|\bharnessValidate\b|\brunHarnessEvaluators\b)|\b(skip|disable)\s+(?:vitest|harness\s+eval|apply\s+gate)\b|\b(do\s+not\s+run|never\s+run)\s+vitest\b/i

/** True when proposed harness text appears to instruct hollowed-out apply validation. */
export function proposalAttemptsGateTamper(proposedBody: string): boolean {
  return GATE_TAMPER_RE.test(proposedBody)
}

/** Gate implementation + evaluator tests — must be clean in git before apply. */
export const HARNESS_GATE_SOURCE_PATHS = [
  'src/main/agent/harnessApply.ts',
  'src/main/agent/harnessHeldOutEval.ts',
  ...HARNESS_EVAL_TESTS
] as const

const GIT_ENV = {
  ...sanitizedTerminalEnv(),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never'
}

/**
 * Returns dirty gate source paths (working tree / index) relative to workspace.
 * If the workspace is not a git repo, checked=false and apply is allowed.
 * If `.git` exists but `git status` fails, returns error (fail-closed — block apply).
 */
export async function harnessGateSourcesDirty(
  workspacePath: string
): Promise<{ checked: boolean; dirtyPaths: string[]; error?: string }> {
  if (!existsSync(join(workspacePath, '.git'))) {
    return { checked: false, dirtyPaths: [] }
  }
  try {
    const { stdout } = await execFile(
      'git',
      ['status', '--porcelain', '--', ...HARNESS_GATE_SOURCE_PATHS],
      {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: GIT_ENV
      }
    )
    const dirtyPaths: string[] = []
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      // porcelain: XY PATH or XY ORIG -> PATH
      const pathPart = line.slice(3).split(' -> ').pop()?.trim()
      if (pathPart) dirtyPaths.push(pathPart.replace(/\\/g, '/'))
    }
    return { checked: true, dirtyPaths }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      checked: true,
      dirtyPaths: [],
      error: `git status failed while checking harness apply gate sources: ${message}`
    }
  }
}

/** Overridable in tests — dirty-gate check before writing default.md. */
export const harnessGateDirtyCheck = {
  run: harnessGateSourcesDirty
}

const VALIDATE_TIMEOUT_MS = 180_000
const VALIDATE_MAX_BUFFER = 8 * 1024 * 1024
const VALIDATE_OUTPUT_CAP = 12_000

const PROPOSED_BODY_RE =
  /##\s*Proposed harness body\s*\n+```(?:markdown|md)?\s*\n([\s\S]*?)\n```/i

export function workspaceHasEditableHarness(workspacePath: string): boolean {
  try {
    const root = canonicalizeWorkspacePath(workspacePath)
    if (!existsSync(root)) return false
    return existsSync(workspaceHarnessPath(workspacePath))
  } catch {
    return false
  }
}

/** Strip an existing Receipt review notes section through end of file. */
export function stripReceiptNotesSection(harness: string): string {
  const re = new RegExp(`\\n${RECEIPT_NOTES_HEADING}\\b[\\s\\S]*$`, 'm')
  return harness.replace(re, '\n').replace(/\s+$/g, '') + '\n'
}

export function buildReceiptNotesSection(
  bullets: readonly string[],
  suggestions: readonly string[]
): string {
  return [
    RECEIPT_NOTES_HEADING,
    '',
    '_Auto-generated from run receipts. Edit or delete before commit._',
    '',
    ...bullets.map((b) => `- ${b}`),
    '',
    'Suggested focus:',
    ...suggestions.map((s) => (s.startsWith('-') ? s : `- ${s}`)),
    ''
  ].join('\n')
}

/**
 * Merge receipt notes into a document (idempotent replace of that section).
 * Do not use this as the default `/harness-review` proposed body: canonical
 * `default.md` must use section tags, not `##` headings.
 */
export function upsertReceiptNotes(
  currentHarness: string,
  bullets: readonly string[],
  suggestions: readonly string[]
): string {
  const base = stripReceiptNotesSection(currentHarness)
  return `${base.trimEnd()}\n\n${buildReceiptNotesSection(bullets, suggestions)}`
}

export function extractProposedHarnessBody(proposalMarkdown: string): string | null {
  const m = PROPOSED_BODY_RE.exec(proposalMarkdown)
  if (!m?.[1]) return null
  const body = m[1].trim()
  return body.length > 0 ? `${body}\n` : null
}

function toWorkspaceRel(workspacePath: string, absolutePath: string): string {
  const root = realpathIfExists(workspacePath)
  const abs = realpathIfExists(absolutePath)
  const rel = relative(root, abs).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) {
    throw new Error(`Path escapes workspace: ${absolutePath}`)
  }
  return rel
}

function resolveProposalPath(workspacePath: string, proposalPath: string): string {
  const trimmed = proposalPath.trim()
  if (!trimmed) throw new Error('proposalPath is required')
  if (isAbsolute(trimmed)) {
    return resolveInsideWorkspace(
      workspacePath,
      toWorkspaceRel(workspacePath, canonicalizeWorkspacePath(trimmed))
    )
  }
  const rel = trimmed.replace(/\\/g, '/').replace(/^\.\//, '')
  return resolveInsideWorkspace(workspacePath, rel)
}

/** Latest proposal by filename sort (ISO-ish stamps sort lexicographically). */
export function findLatestHarnessProposal(workspacePath: string): string | null {
  const dir = resolveInsideWorkspace(workspacePath, HARNESS_PROPOSALS_REL)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => b.localeCompare(a))
  if (files.length === 0) return null
  return join(dir, files[0]!)
}

export function previewHarnessApply(
  workspacePath: string,
  proposalPath?: string | null
): HarnessPreviewApplyResult {
  if (!workspaceHasEditableHarness(workspacePath)) {
    throw new Error(
      `Workspace has no editable harness at ${WORKSPACE_HARNESS_REL}. Open the Agent V repo (or a fork) to apply.`
    )
  }
  const resolved =
    proposalPath?.trim()
      ? resolveProposalPath(workspacePath, proposalPath)
      : findLatestHarnessProposal(workspacePath)
  if (!resolved || !existsSync(resolved)) {
    throw new Error('No harness proposal found. Run `/harness-review` first.')
  }
  const proposalMarkdown = readFileSync(resolved, 'utf8')
  const proposed = extractProposedHarnessBody(proposalMarkdown)
  if (!proposed) {
    throw new Error(
      'Proposal is missing a ## Proposed harness body fenced markdown block. Edit the proposal or re-run `/harness-review`.'
    )
  }
  const current = readFileSync(workspaceHarnessPath(workspacePath), 'utf8')
  const relativePath = toWorkspaceRel(workspacePath, resolved)
  return {
    proposalPath: resolved,
    relativePath,
    current,
    proposed,
    changed: current.replace(/\r\n/g, '\n') !== proposed.replace(/\r\n/g, '\n')
  }
}

function preferPnpm(workspace: string): boolean {
  return existsSync(join(workspace, 'pnpm-lock.yaml'))
}

function shellCommand(workspace: string, command: string): { bin: string; args: string[] } {
  if (process.platform === 'win32') {
    return { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { bin: shell, args: ['-lc', command] }
}

/** Fixed harness evaluators — vitest subset used as the apply gate. */
export async function runHarnessEvaluators(
  workspacePath: string
): Promise<{ ok: boolean; output: string }> {
  const pm = preferPnpm(workspacePath) ? 'pnpm' : 'npx'
  const files = HARNESS_EVAL_TESTS.join(' ')
  const command =
    pm === 'pnpm' ? `pnpm exec vitest run ${files}` : `npx vitest run ${files}`
  const { bin, args } = shellCommand(workspacePath, command)
  try {
    const { stdout, stderr } = await execFile(bin, args, {
      cwd: workspacePath,
      timeout: VALIDATE_TIMEOUT_MS,
      maxBuffer: VALIDATE_MAX_BUFFER,
      env: sanitizedTerminalEnv(process.env),
      windowsHide: true
    })
    const output = `${stdout ?? ''}${stderr ?? ''}`.slice(0, VALIDATE_OUTPUT_CAP)
    return { ok: true, output }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`.slice(
      0,
      VALIDATE_OUTPUT_CAP
    )
    return { ok: false, output }
  }
}

/** Overridable in tests — fixed harness evaluators used as the apply gate. */
export const harnessValidate = {
  run: runHarnessEvaluators
}

/**
 * Apply a proposal to canonical resources/harness/default.md after explicit confirm.
 * Mutates only that plain-text file. Runs harness evaluators; reverts from backup on failure.
 * Evaluator / gate-test changes are PR-only (see HARNESS_APPLY_SURFACE_NOTE).
 */
export async function applyHarnessProposal(
  workspacePath: string,
  opts: { proposalPath?: string | null; confirm: boolean }
): Promise<HarnessApplyResult> {
  if (!opts.confirm) {
    throw new Error('Harness apply requires confirm: true')
  }
  const preview = previewHarnessApply(workspacePath, opts.proposalPath)
  if (!preview.changed) {
    return {
      applied: false,
      proposalPath: preview.proposalPath,
      relativePath: preview.relativePath,
      harnessPath: WORKSPACE_HARNESS_REL,
      validationOk: true,
      validationOutput: `No changes — harness already matches proposed body.\n${HARNESS_APPLY_SURFACE_NOTE}`,
      reverted: false
    }
  }

  if (proposalAttemptsGateTamper(preview.proposed)) {
    return {
      applied: false,
      proposalPath: preview.proposalPath,
      relativePath: preview.relativePath,
      harnessPath: WORKSPACE_HARNESS_REL,
      validationOk: false,
      validationOutput: [
        'Refused: proposed harness body appears to disable or hollow out the apply gate.',
        HARNESS_APPLY_SURFACE_NOTE
      ].join('\n'),
      reverted: false
    }
  }

  const gateDirty = await harnessGateDirtyCheck.run(workspacePath)
  if (gateDirty.error) {
    return {
      applied: false,
      proposalPath: preview.proposalPath,
      relativePath: preview.relativePath,
      harnessPath: WORKSPACE_HARNESS_REL,
      validationOk: false,
      validationOutput: [
        'Refused: could not verify harness apply gate sources are clean.',
        gateDirty.error,
        HARNESS_APPLY_SURFACE_NOTE
      ].join('\n'),
      reverted: false
    }
  }
  if (gateDirty.checked && gateDirty.dirtyPaths.length > 0) {
    return {
      applied: false,
      proposalPath: preview.proposalPath,
      relativePath: preview.relativePath,
      harnessPath: WORKSPACE_HARNESS_REL,
      validationOk: false,
      validationOutput: [
        'Refused: harness apply gate sources have uncommitted changes.',
        'Commit or discard edits to evaluator / gate tests before `/harness-apply`.',
        `Dirty: ${gateDirty.dirtyPaths.join(', ')}`,
        HARNESS_APPLY_SURFACE_NOTE
      ].join('\n'),
      reverted: false
    }
  }

  const target = workspaceHarnessPath(workspacePath)
  const backupPath = resolveInsideWorkspace(workspacePath, HARNESS_BACKUP_REL)
  mkdirSync(dirname(backupPath), { recursive: true })
  writeFileSync(backupPath, preview.current, 'utf8')

  atomicWriteFile(target, preview.proposed)

  const validation = await harnessValidate.run(workspacePath)
  if (!validation.ok) {
    writeFileSync(target, preview.current, 'utf8')
    try {
      renameSync(backupPath, `${backupPath}.failed-${Date.now()}`)
    } catch {
      // keep .bak
    }
    return {
      applied: false,
      proposalPath: preview.proposalPath,
      relativePath: preview.relativePath,
      harnessPath: WORKSPACE_HARNESS_REL,
      validationOk: false,
      validationOutput: `${validation.output}\n${HARNESS_APPLY_SURFACE_NOTE}`,
      reverted: true
    }
  }

  return {
    applied: true,
    proposalPath: preview.proposalPath,
    relativePath: preview.relativePath,
    harnessPath: WORKSPACE_HARNESS_REL,
    validationOk: true,
    validationOutput: `${validation.output.slice(0, 1800)}\n${HARNESS_APPLY_SURFACE_NOTE}`,
    reverted: false
  }
}
