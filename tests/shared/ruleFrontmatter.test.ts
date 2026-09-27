import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  isAlwaysApplyRule,
  isRootInstructionFileName,
  isRootInstructionFilePath,
  matchFrontmatterKey,
  parseRuleFrontmatter,
  ROOT_INSTRUCTION_FILES,
  splitFrontmatter,
  stripQuotes
} from '@shared/rules'
import { clearRulesCache, listWorkspaceRulesForMention } from '@main/agent/context/rules'
import { RULE_APPLY_CASES } from '../helpers/ruleFrontmatterCases'

describe('splitFrontmatter', () => {
  it('reports no frontmatter for a plain body and for an unterminated fence', () => {
    expect(splitFrontmatter('# hi\nbody')).toEqual({
      block: null,
      lines: null,
      body: '# hi\nbody'
    })
    const open = splitFrontmatter('---\nalwaysApply: false\nstill open')
    expect(open.lines).toBeNull()
    expect(open.body).toBe('---\nalwaysApply: false\nstill open')
  })

  it('returns an empty line list for an empty block, not null', () => {
    const split = splitFrontmatter('---\n---\nbody')
    expect(split.lines).toEqual([])
    expect(split.body).toBe('body')
  })

  it('keeps frontmatter lines verbatim so an editor can write them back', () => {
    const split = splitFrontmatter('---\nglobs:\n  - "*.ts"\n---\n\nPrefer named exports.\n')
    expect(split.lines).toEqual(['globs:', '  - "*.ts"'])
    expect(split.body).toBe('\nPrefer named exports.\n')
  })

  it('strips a BOM and handles CRLF files', () => {
    const split = splitFrontmatter('\uFEFF---\r\nalwaysApply: false\r\n---\r\nbody\r\n')
    // The block ends at the CR before the closing fence, so the line keeps it.
    // `matchFrontmatterKey` has to tolerate that: `.` does not match a CR, so a
    // stricter pattern read every key in a CRLF rule file as absent.
    expect(split.lines).toEqual(['alwaysApply: false\r'])
    expect(matchFrontmatterKey(split.lines![0]!)).toEqual({
      key: 'alwaysApply',
      value: 'false'
    })
    expect(split.body).toBe('body\r\n')
  })
})

describe('frontmatter key lines', () => {
  it('matches a key and trims its value', () => {
    expect(matchFrontmatterKey('description:  Docs only  ')).toEqual({
      key: 'description',
      value: 'Docs only'
    })
    expect(matchFrontmatterKey('alwaysApply : false')).toEqual({
      key: 'alwaysApply',
      value: 'false'
    })
  })

  it('rejects an indented line so nested keys are never read as top-level', () => {
    expect(matchFrontmatterKey('  description: nested')).toBeNull()
    expect(matchFrontmatterKey('- "*.ts"')).toBeNull()
  })

  it('strips one layer of wrapping quotes', () => {
    expect(stripQuotes('"Docs only"')).toBe('Docs only')
    expect(stripQuotes("'Docs only'")).toBe('Docs only')
    expect(stripQuotes('Docs "only"')).toBe('Docs "only')
  })
})

describe('root instruction files', () => {
  it('matches every name in the list, case-insensitively', () => {
    for (const name of ROOT_INSTRUCTION_FILES) {
      expect(isRootInstructionFileName(name)).toBe(true)
      expect(isRootInstructionFileName(name.toLowerCase())).toBe(true)
      expect(isRootInstructionFilePath(name)).toBe(true)
    }
    expect(isRootInstructionFileName('README.md')).toBe(false)
  })

  it('only counts a root-level copy as the project instruction file', () => {
    expect(isRootInstructionFilePath('./AGENTS.md')).toBe(true)
    expect(isRootInstructionFilePath('packages/app/AGENTS.md')).toBe(false)
    expect(isRootInstructionFilePath('.vyotiq/rules/AGENTS.md')).toBe(false)
  })
})

/**
 * The reason this module exists: the composer's "already in the prompt" note
 * and the agent's own rule list used to be hand-synced copies of the same
 * decision. The composer side reads the same table in
 * tests/renderer/composer/mentionModel.test.ts.
 */
describe('the agent rule list follows the shared alwaysApply policy', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-fm-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(join(workspace, '.vyotiq', 'rules'), { recursive: true })
    clearRulesCache()
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    clearRulesCache()
  })

  it('reports the table alwaysApply for every frontmatter shape', async () => {
    for (const { file, raw } of RULE_APPLY_CASES) {
      writeFileSync(join(workspace, '.vyotiq', 'rules', file), raw)
    }

    const listed = await listWorkspaceRulesForMention(workspace)
    expect(listed.length).toBe(RULE_APPLY_CASES.length)

    for (const { file, raw, applies } of RULE_APPLY_CASES) {
      const path = `.vyotiq/rules/${file}`
      const fromAgent = listed.find((r) => r.path === path)
      expect(fromAgent, path).toBeDefined()
      expect(fromAgent!.alwaysApply, path).toBe(applies)
      expect(isAlwaysApplyRule(parseRuleFrontmatter(raw).meta), path).toBe(applies)
    }
  })

  it('lists a root instruction file as applying whatever its frontmatter says', async () => {
    writeFileSync(join(workspace, 'AGENTS.md'), '---\nalwaysApply: false\n---\nstill applies')

    const listed = await listWorkspaceRulesForMention(workspace)
    // Root files have no alwaysApply contract: readWorkspaceRules injects them
    // as-is, so the flag in them is ignored here too.
    const agents = listed.find((r) => r.path === 'AGENTS.md')
    expect(agents?.alwaysApply).toBe(true)
    expect(agents?.applies).toBe('always')
  })
})
