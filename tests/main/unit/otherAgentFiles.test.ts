import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { formatWorkspaceCommand } from '@shared/slashCommands'
import { instructionImports, isRootInstructionFilePath } from '@shared/rules'
import { clearRulesCache, readWorkspaceRules } from '@main/agent/context/rules'
import {
  clearWorkspaceCommandsCache,
  readWorkspaceCommands,
  resolveWorkspaceCommand,
  setPersonalCommandsHomeForTests
} from '@main/agent/slashCommands/workspaceCommands'

const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-other-agents-'))
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn(async () => '') }
}))

let ws: string
let home: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-other-ws-'))
  home = mkdtempSync(join(tmpdir(), 'vyotiq-other-home-'))
  clearRulesCache()
  clearWorkspaceCommandsCache()
})
afterEach(() => {
  setPersonalCommandsHomeForTests(undefined)
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function put(root: string, rel: string, text: string): void {
  const full = join(root, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

describe('command arguments', () => {
  it('fills $ARGUMENTS, $1…$9 and Copilot ${input}', () => {
    expect(formatWorkspaceCommand('Fix issue $ARGUMENTS now', '123 urgent')).toBe('Fix issue 123 urgent now')
    expect(formatWorkspaceCommand('Review PR #$1 with priority $2', '456 "very high"')).toBe(
      'Review PR #456 with priority very high'
    )
    expect(formatWorkspaceCommand('Only $1 and $3', 'a')).toBe('Only a and ')
    expect(formatWorkspaceCommand('Explain ${input:topic}', 'closures')).toBe('Explain closures')
    expect(formatWorkspaceCommand('Plain body', 'extra')).toBe('Plain body\n\nextra')
  })
})

describe('instruction files', () => {
  it('reads CLAUDE.local.md, GEMINI.md and .github/copilot-instructions.md', async () => {
    put(ws, 'GEMINI.md', 'Use tabs.')
    put(ws, 'CLAUDE.local.md', 'My local notes.')
    put(ws, '.github/copilot-instructions.md', 'Prefer small PRs.')
    const files = await readWorkspaceRules(ws)
    expect(files.map((f) => f.path)).toEqual(['CLAUDE.local.md', 'GEMINI.md', '.github/copilot-instructions.md'])
    expect(isRootInstructionFilePath('.github/copilot-instructions.md')).toBe(true)
    expect(isRootInstructionFilePath('docs/AGENTS.md')).toBe(false)
  })

  it('finds @path imports outside code, and not @handles', () => {
    const text = [
      'See @docs/style.md and @./notes.md, then @README.md.',
      'Ask @alice. Not `@src/code.ts` either.',
      '```',
      '@scripts/in-fence.md',
      '```'
    ].join('\n')
    expect(instructionImports(text)).toEqual(['docs/style.md', './notes.md', 'README.md'])
  })

  it('adds imported files after the file that names them, inside the workspace only', async () => {
    put(ws, 'CLAUDE.md', 'Rules. @docs/style.md @../outside.md @docs/missing.md')
    put(ws, 'docs/style.md', 'Two spaces. @deeper.md')
    put(ws, 'docs/deeper.md', 'Deeper rule.')
    const files = await readWorkspaceRules(ws)
    expect(files.map((f) => f.path)).toEqual(['CLAUDE.md', 'docs/style.md', 'docs/deeper.md'])
  })
})

describe('skills from other agents', () => {
  it('reads .claude/skills and .agents/skills, and says where from', async () => {
    const local = await import('@main/agent/skills/local')
    local.setPersonalSkillsRootForTests(home)
    const skill = (name: string): string => `---\nname: ${name}\ndescription: Does ${name}.\n---\n\nDo ${name}.\n`
    put(ws, '.claude/skills/lint-fix/SKILL.md', skill('lint-fix'))
    put(ws, '.agents/skills/release-notes/SKILL.md', skill('release-notes'))
    try {
      const items = local.listLocalSkillItems(ws)
      expect(items.find((s) => s.name === 'lint-fix')).toMatchObject({
        origin: 'claude',
        relativePath: '.claude/skills/lint-fix/SKILL.md'
      })
      expect(items.find((s) => s.name === 'release-notes')?.origin).toBe('agents')
      expect(local.personalClaudeSkillsRoot()).toBeNull()
    } finally {
      local.setPersonalSkillsRootForTests(null)
    }
  })
})

describe('commands from other agents', () => {
  it('reads .claude/commands, .github/prompts/*.prompt.md and personal commands, workspace first', async () => {
    put(ws, '.claude/commands/review.md', '---\ndescription: Review it\n---\nReview $ARGUMENTS')
    put(ws, '.github/prompts/explain.prompt.md', '---\ndescription: Explain\n---\nExplain ${input:topic}')
    put(ws, '.github/prompts/README.md', 'Not a prompt file.')
    put(home, '.vyotiq/commands/standup.md', 'Write my standup.')
    put(home, '.claude/commands/review.md', 'Personal review, shadowed.')
    setPersonalCommandsHomeForTests(home)
    const files = await readWorkspaceCommands(ws)
    const by = Object.fromEntries(files.map((f) => [f.trigger, f]))
    expect(Object.keys(by).sort()).toEqual(['explain', 'review', 'standup'])
    expect(by.review).toMatchObject({ source: 'claude', relativePath: '.claude/commands/review.md' })
    expect(by.explain?.source).toBe('github')
    expect(by.standup).toMatchObject({ source: 'personal', relativePath: '~/.vyotiq/commands/standup.md' })
  })

  it('hands on the model and mode a command asks for', async () => {
    put(ws, '.claude/commands/fast.md', '---\nmodel: claude-haiku-4-5\n---\nQuick look at $ARGUMENTS')
    put(ws, '.claude/commands/same.md', '---\nmodel: inherit\n---\nKeep the model')
    put(ws, '.github/prompts/plan.prompt.md', '---\nmode: ask\nmodel: GPT-4o (copilot)\n---\nPlan it')
    put(ws, '.github/prompts/fix.prompt.md', '---\nagent: edit\n---\nFix it')
    put(ws, '.github/prompts/custom.prompt.md', '---\nagent: my-reviewer\n---\nReview it')
    const files = await readWorkspaceCommands(ws)
    const by = Object.fromEntries(files.map((f) => [f.trigger, f]))
    expect(by.fast).toMatchObject({ model: 'claude-haiku-4-5' })
    expect(by.fast?.mode).toBeUndefined()
    expect(by.same?.model).toBeUndefined()
    expect(by.plan).toMatchObject({ mode: 'ask', model: 'GPT-4o (copilot)' })
    expect(by.fix?.mode).toBe('agent')
    expect(by.custom?.mode).toBeUndefined()
    const sent = await resolveWorkspaceCommand('workspace:.claude/commands/fast.md', ws, 'src/a.ts')
    expect(sent).toEqual({ action: 'send', message: 'Quick look at src/a.ts', model: 'claude-haiku-4-5' })
  })
})
