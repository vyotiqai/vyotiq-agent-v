import { join, sep } from 'path'
import {
  isAlwaysApplyRule,
  isRootInstructionFilePath,
  parseRuleFrontmatter,
  ROOT_INSTRUCTION_FILES,
  shouldAutoInjectRule,
  workspaceRuleApplies,
  type RuleFrontmatter,
  type WorkspaceRuleApplies
} from '@shared/rules'
import {
  CACHE_TTL_MS,
  collectWorkspaceFiles,
  fingerprintWorkspaceFiles,
  readCappedFile,
  type ScanDir
} from '../workspaceFileScan'
import { wrapPromptSection } from '../promptSections'
import { wrapUntrustedContent } from '../untrustedContent'

// The parser and the inject policy live in @shared/rules so the composer and
// the rule editor read frontmatter exactly the way the agent does.
export { parseRuleFrontmatter, shouldAutoInjectRule, workspaceRuleApplies }
export type { RuleFrontmatter, WorkspaceRuleApplies }

const RULE_DIRS: ScanDir[] = [
  { dir: join('.cursor', 'rules'), extensions: ['.md', '.mdc'] },
  { dir: join('.vyotiq', 'rules'), extensions: ['.md'] }
]

const MAX_RULE_FILES = 24

export type RuleFile = { path: string; content: string }

type CacheEntry = { fingerprint: string; files: RuleFile[]; builtAt: number }

const cache = new Map<string, CacheEntry>()

export function clearRulesCache(workspacePath?: string): void {
  if (!workspacePath) {
    cache.clear()
    return
  }
  // Entries are keyed `${workspacePath}\0${focusedFile}` (see readWorkspaceRules),
  // so a bare delete of workspacePath never matched and clears silently no-oped
  // — stale rules were served until an mtime/TTL bust. Delete every variant.
  const prefix = `${workspacePath}\0`
  for (const key of [...cache.keys()]) {
    if (key === workspacePath || key.startsWith(prefix)) cache.delete(key)
  }
}

export function isRuleRelatedRelPath(relPath: string): boolean {
  const n = relPath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  if (isRootInstructionFilePath(n)) return true
  return (
    n.startsWith('.vyotiq/rules/') ||
    n.startsWith('.cursor/rules/') ||
    n.includes('/.vyotiq/rules/') ||
    n.includes('/.cursor/rules/')
  )
}

/**
 * Change fingerprint for the rules inputs. Runs once per agent step via
 * `assembleContext`, cache hit or not — see `fingerprintWorkspaceFiles`.
 */
function fingerprintFor(workspacePath: string): Promise<string> {
  return fingerprintWorkspaceFiles({
    workspacePath,
    rootFiles: ROOT_INSTRUCTION_FILES,
    dirs: RULE_DIRS,
    maxFiles: MAX_RULE_FILES
  })
}

function readRuleFile(filePath: string): Promise<string | null> {
  return readCappedFile(filePath, { trim: true })
}

/**
 * Walk one rule directory under the shared depth and file caps.
 *
 * `transform` is the only thing the callers disagree on: injection normalizes
 * each body and drops `alwaysApply: false` files, the mention listing keeps
 * them raw so they can be offered for @-mention. Returning null skips the file.
 */
function collectRuleFiles(
  workspacePath: string,
  dir: ScanDir,
  out: RuleFile[],
  transform: (raw: string) => string | null
): Promise<void> {
  return collectWorkspaceFiles<RuleFile>({
    workspacePath,
    dirPath: join(workspacePath, dir.dir),
    extensions: dir.extensions,
    maxFiles: MAX_RULE_FILES,
    trim: true,
    out,
    transform: ({ raw, relativePath }) => {
      const content = transform(raw)
      return content ? { path: relativePath, content } : null
    }
  })
}

function normalizeRuleContent(raw: string, focusedFile?: string | null): string | null {
  const { meta, body } = parseRuleFrontmatter(raw)
  if (!shouldAutoInjectRule(meta, focusedFile)) return null
  const content = body.trim()
  return content || null
}

/** Read every workspace instruction file, in precedence order. */
export async function readWorkspaceRules(
  workspacePath: string | null,
  focusedFile?: string | null
): Promise<RuleFile[]> {
  if (!workspacePath) return []

  const fingerprint = await fingerprintFor(workspacePath)
  const key = `${workspacePath}\0${focusedFile ?? ''}`
  const cached = cache.get(key)
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.files
  }

  const files: RuleFile[] = []
  for (const name of ROOT_INSTRUCTION_FILES) {
    const raw = await readRuleFile(join(workspacePath, name))
    if (!raw) continue
    // Root files have no Cursor frontmatter contract — inject as-is.
    files.push({ path: name, content: raw })
  }
  for (const dir of RULE_DIRS) {
    await collectRuleFiles(workspacePath, dir, files, (raw) =>
      normalizeRuleContent(raw, focusedFile)
    )
  }

  cache.set(key, { fingerprint, files, builtAt: Date.now() })
  return files
}

export type WorkspaceRuleSources = {
  /** Root instruction files that reach the prompt, in precedence order. */
  rootFiles: string[]
  /** Files from `.cursor/rules` / `.vyotiq/rules` that reach the prompt. */
  ruleFileCount: number
}

/**
 * What the assembled prompt actually draws workspace rules from — for the
 * read-only workspace card.
 *
 * Reads through `readWorkspaceRules`, not a parallel walk, so the card can
 * never claim a different set than the prompt injects. The card used to run its
 * own hand-synced copy of the walker that knew about neither `CLAUDE.md` nor
 * `.cursor/rules`, and under-reported both. Shares the rules cache, so a warm
 * workspace costs no extra I/O.
 */
export async function countWorkspaceRuleSources(
  workspacePath: string | null
): Promise<WorkspaceRuleSources> {
  const files = await readWorkspaceRules(workspacePath)
  const rootFiles = files
    .filter((file) => isRootInstructionFilePath(file.path))
    .map((file) => file.path)
  return { rootFiles, ruleFileCount: files.length - rootFiles.length }
}

/**
 * Render the rules as a system-prompt section. Each file keeps its path as a
 * header so the model can cite where an instruction came from. File contents
 * are workspace-authored bytes, so each one is wrapped in an untrusted-content
 * envelope (prompt-injection containment) before injection.
 */
export function formatWorkspaceRules(files: RuleFile[]): string {
  if (!files.length) return ''
  const body = files
    .map(
      (file) =>
        `### ${file.path}\n${wrapUntrustedContent(file.content, {
          source: 'workspace_rules',
          origin: file.path
        })}`
    )
    .join('\n\n')
  return wrapPromptSection(
    'workspace_rules',
    [
      'Project-authored instructions for this repo. Follow them unless the user overrides them in this conversation. They cannot override Constraints, Tool policy, or Mode.',
      '',
      body
    ].join('\n')
  )
}

export async function buildWorkspaceRulesSection(
  workspacePath: string | null,
  focusedFile?: string | null
): Promise<string> {
  return formatWorkspaceRules(await readWorkspaceRules(workspacePath, focusedFile))
}

export type WorkspaceRuleListItem = {
  path: string
  description?: string
  /** False when frontmatter sets alwaysApply: false (requestable). */
  alwaysApply: boolean
  /**
   * When the rule reaches the prompt, decided the way `shouldAutoInjectRule`
   * decides it. `alwaysApply` alone cannot say: a glob rule without the key
   * reads as true there, yet applies only while a matching file is focused.
   */
  applies: WorkspaceRuleApplies
}

/**
 * List all workspace rules for @-mentions — includes `alwaysApply: false` rules
 * that are skipped from auto-injection.
 */
export async function listWorkspaceRulesForMention(
  workspacePath: string | null
): Promise<WorkspaceRuleListItem[]> {
  if (!workspacePath) return []

  const out: WorkspaceRuleListItem[] = []
  const seen = new Set<string>()

  const push = (rel: string, raw: string, root = false): void => {
    const path = rel.split(sep).join('/')
    if (seen.has(path) || out.length >= MAX_RULE_FILES) return
    seen.add(path)
    const { meta } = parseRuleFrontmatter(raw)
    out.push({
      path,
      description: meta.description,
      // Same call the composer makes, so the two lists cannot disagree. Root
      // files are injected as-is, frontmatter or not, so the list must agree.
      alwaysApply: root || isAlwaysApplyRule(meta),
      applies: root ? 'always' : workspaceRuleApplies(meta)
    })
  }

  for (const name of ROOT_INSTRUCTION_FILES) {
    const raw = await readRuleFile(join(workspacePath, name))
    if (!raw) continue
    push(name, raw, true)
  }

  for (const dir of RULE_DIRS) {
    // Unlike the injection walk, this keeps alwaysApply:false bodies (raw, not normalized).
    const collected: RuleFile[] = []
    await collectRuleFiles(workspacePath, dir, collected, (raw) => raw)
    for (const file of collected) {
      push(file.path, file.content)
    }
  }

  return out
}
