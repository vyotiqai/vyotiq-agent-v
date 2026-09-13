import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import {
  extractFoldFacts,
  isPlausibleWorkspaceFilePath,
  parseContractDoneWhen,
  parseContractGoal
} from '@main/agent/context/foldFacts'
import {
  clipVerifyFailures,
  expandBraceGlobs,
  extractClaimedPaths,
  FILE_COVERAGE_MAX_NEEDED,
  MAX_VERIFY_FAILURES,
  missingFactsFocus,
  pathMentionedInText,
  requiredFoldFactsFocus,
  verifyCompactionSummary
} from '@main/agent/context/verifyCompaction'

const RECORDED_SUMMARY = readFileSync(
  join(__dirname, '../../fixtures/compact/recorded-81cf5721-verify-failed-summary.md'),
  'utf8'
)
  .replace(
    /^(Session Intent|Files Touched|Key Decisions|Constraints|Open Bugs\/Blockers|Next Steps)$/gm,
    '## $1'
  )
  .replace(/^(plan\.md|contract\.md)(\s+\(.*\))$/gm, '- $1$2')
  .trim()

const CORE_DECISION =
  'Primary language/runtime for the agent core?: Not sure \u2014 recommend one'
const INTERFACE_DECISION =
  'Primary interface / deployment surface?: Not sure \u2014 recommend one'
const P5_DECISION =
  'MCP transports to implement in phase P5?: Both stdio and HTTP/SSE transports at P5'

/** Key Decisions from compaction_verify_failed at 2026-08-14T02:18:32.418Z. */
const RESTATED_KEY_DECISIONS = `## Key Decisions
- **Primary language/runtime for the agent core?**: TypeScript on Node.js LTS 22 (recommended; MCP SDK first-class, strict typing for tool-call JSON)
- **Primary interface / deployment surface?**: Library-first core (\`createAgent\`) + thin CLI + HTTP/SSE server (recommended)
- **LLM provider strategy?**: Provider-agnostic (OpenAI, Anthropic, local/self-host, etc.) via a thin adapter
- **Is this an original agent framework (build core from scratch) or a thin layer on an existing agent framework/sdk?**: Original core + MCP for external connections
- **MCP transports to implement in phase P5?**: Both stdio and HTTP/SSE transports at P5
- **Confirmation UX for destructive tools?**: Both: interactive CLI prompt for CLI users AND a programmable approval callback for library integration
- **Auth for external MCP servers at P5?**: Yes — token/header auth support at P5
- **Observability: pino only now, or add OpenTelemetry?**: Include minimal structured logging/OTel from P0`

const PREFIX_FOLDED_TEXT = [
  'plan.md',
  'contract.md',
  '`core/llm`',
  '`@modelcontextprotocol/sdk`',
  '`LLMProvider.chat`',
  '`core/agent`',
  '`core/context`',
  '`core/mcp`',
  '`core/memory`',
  '`core/plugins`',
  '`core/safety`',
  '`core/tools`'
].join('\n')

function assistantEdit(path: string, id = 'c1'): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'edit', arguments: JSON.stringify({ path, contents: 'x' }) }]
  }
}

function toolOk(id: string, name: string, content = 'ok'): ChatMessage {
  return { role: 'tool', content, toolCallId: id, toolName: name, ok: true }
}

function askAnswer(id: string, answer: string): ChatMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'ask_question', arguments: '{}' }]
    },
    {
      role: 'tool',
      content: `User answered: ${answer}`,
      toolCallId: id,
      toolName: 'ask_question',
      ok: true
    }
  ]
}

describe('extractFoldFacts', () => {
  it('collects inspect, write, and ask_question decisions from the folded prefix', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'fix auth' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'r1', name: 'read', arguments: JSON.stringify({ file: 'src/auth.ts' }) }]
      },
      toolOk('r1', 'read', 'export const auth = 1'),
      assistantEdit('src/auth.ts', 'e1'),
      toolOk('e1', 'edit'),
      ...askAnswer('q1', 'Use JWT')
    ]
    const facts = extractFoldFacts(messages)
    expect(facts.files).toContain('src/auth.ts')
    expect(facts.wroteFiles).toContain('src/auth.ts')
    expect(facts.decisions).toEqual(['Use JWT'])
    expect(facts.todos).toEqual([])
    expect(facts.doneWhen).toEqual([])
  })

  it('collects prose paths, open todos, and a distinctive contract goal', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please update `src/auth/rewrite.ts` after the decision.' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool',
        content: '0/1 complete\n[ ] (auth) Rewrite auth to JWT',
        toolCallId: 't1',
        toolName: 'todo_write',
        ok: true
      }
    ]
    const facts = extractFoldFacts(messages, {
      contract: '## Goal\n\nRewrite auth to JWT\n\n## Done when\n\n- Auth works\n'
    })
    expect(facts.files).toContain('src/auth/rewrite.ts')
    expect(facts.todos).toEqual(['Rewrite auth to JWT'])
    expect(facts.contractGoal).toBe('Rewrite auth to JWT')
    expect(facts.doneWhen).toEqual(['Auth works'])
  })

  it('does not treat identifier, URL, and flag junk in prose as files', () => {
    const facts = extractFoldFacts([
      {
        role: 'user',
        content:
          'See `e.g.` `GET /health` `POST /run` `process.env` `process.argv` `logger.error` `import.meta.url` `--prompt/-p` `file:///C:/tmp` `SEAM_NAMES.MODEL_CALL` vs `src/auth.ts`'
      }
    ])
    expect(facts.files).toEqual(['src/auth.ts'])
  })

  it('does not count list_dir directories or write-alias names incorrectly', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'inspect then write' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'd1', name: 'list_dir', arguments: JSON.stringify({ path: 'src/main/agent' }) },
          { id: 'w1', name: 'write', arguments: JSON.stringify({ path: 'src/auth.ts', contents: 'x' }) },
          { id: 'm1', name: 'memory_write', arguments: JSON.stringify({ path: 'notes/agent-v-build.md' }) }
        ]
      },
      toolOk('d1', 'list_dir'),
      toolOk('w1', 'write'),
      toolOk('m1', 'memory_write')
    ]
    const facts = extractFoldFacts(messages)
    expect(facts.files).not.toContain('src/main/agent')
    expect(facts.files).toContain('src/auth.ts')
    expect(facts.files).toContain('notes/agent-v-build.md')
    expect(facts.wroteFiles).toContain('src/auth.ts')
    expect(facts.wroteFiles).not.toContain('notes/agent-v-build.md')
  })
})

describe('isPlausibleWorkspaceFilePath', () => {
  it('keeps workspace files and dotfiles', () => {
    expect(isPlausibleWorkspaceFilePath('src/cli/index.ts')).toBe(true)
    expect(isPlausibleWorkspaceFilePath('package.json')).toBe(true)
    expect(isPlausibleWorkspaceFilePath('.gitignore')).toBe(true)
    expect(isPlausibleWorkspaceFilePath('.cursor/rules/foo.mdc')).toBe(true)
  })

  it('rejects directories, packages, and d7dcdfbf prose tokens', () => {
    expect(isPlausibleWorkspaceFilePath('src/core')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('src/core/llm/')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('@modelcontextprotocol/sdk')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('e.g.')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('GET /health')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('--prompt/-p')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('process.env')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('src/core/telemetry.ts:28')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('/')).toBe(false)
  })
})

describe('parseContractGoal', () => {
  it('ignores generic chat stubs', () => {
    expect(parseContractGoal('## Goal\n\nchat\n\n## Done when\n\n- done\n')).toBeUndefined()
  })

  it('returns a distinctive goal', () => {
    expect(parseContractGoal('## Goal\n\nRewrite auth to JWT\n\n## Done when\n')).toBe(
      'Rewrite auth to JWT'
    )
  })
})

describe('parseContractDoneWhen', () => {
  it('ignores createRun boilerplate bullets', () => {
    expect(
      parseContractDoneWhen(
        [
          '## Goal',
          '',
          'chat',
          '',
          '## Done when',
          '',
          '- The goal above is satisfied (check outcomes: read results, command output, or user-visible success).',
          '- Or blockers are explained clearly and no further narrow retry will help.',
          '- Update this file if scope or done-when changes.'
        ].join('\n')
      )
    ).toEqual([])
  })

  it('keeps custom done-when bullets', () => {
    expect(
      parseContractDoneWhen('## Done when\n\n- Login uses JWT\n- Tests pass\n')
    ).toEqual(['Login uses JWT', 'Tests pass'])
  })
})

describe('verifyCompactionSummary', () => {
  const facts = {
    files: ['src/auth.ts', 'src/session.ts'],
    wroteFiles: ['src/auth.ts'],
    decisions: ['Use JWT'],
    todos: [] as string[],
    doneWhen: [] as string[]
  }

  it('passes a faithful summary', () => {
    const summary = `## Session Intent
Auth rewrite

## Files Touched
- src/auth.ts
- src/session.ts

## Key Decisions
- Use JWT

## Next Steps
- Add tests`
    const result = verifyCompactionSummary(summary, facts)
    expect(result.ok).toBe(true)
    expect(result.coverage).toBe(1)
    expect(result.failures).toEqual([])
  })

  it('fails on an invented path', () => {
    const summary = `## Files Touched
- src/auth.ts
- src/invented.ts

## Key Decisions
- Use JWT`
    const result = verifyCompactionSummary(summary, facts)
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'invented_path' && f.detail.includes('invented'))).toBe(
      true
    )
  })

  it('fails when a retained decision is dropped', () => {
    const summary = `## Files Touched
- src/auth.ts
- src/session.ts

## Key Decisions
- (none)`
    const result = verifyCompactionSummary(summary, facts)
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_decision')).toBe(true)
  })

  it('fails when a written file is omitted', () => {
    const summary = `## Files Touched
- src/session.ts

## Key Decisions
- Use JWT`
    const result = verifyCompactionSummary(summary, facts)
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_wrote_file')).toBe(true)
  })

  it('passes when there are no extractive facts', () => {
    const result = verifyCompactionSummary('## Session Intent\nChat only', {
      files: [],
      wroteFiles: [],
      decisions: [],
      todos: [],
      doneWhen: []
    })
    expect(result.ok).toBe(true)
    expect(result.coverage).toBe(1)
  })

  it('treats a claimed path as known when it appears in folded source text', () => {
    const summary = `## Files Touched
- notes/plan.md`
    const result = verifyCompactionSummary(
      summary,
      { files: [], wroteFiles: [], decisions: [], todos: [], doneWhen: [] },
      'user: see notes/plan.md'
    )
    expect(result.ok).toBe(true)
    expect(extractClaimedPaths(summary).some((p) => p.includes('plan.md'))).toBe(true)
  })

  it('fails when a distinctive contract goal is dropped', () => {
    const result = verifyCompactionSummary(
      `## Session Intent
Auth work

## Files Touched
- src/auth.ts
- src/session.ts

## Key Decisions
- Use JWT`,
      { ...facts, contractGoal: 'Rewrite auth to JWT' }
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_contract_goal')).toBe(true)
  })

  it('passes when the contract goal is cited', () => {
    const result = verifyCompactionSummary(
      `## Session Intent
Rewrite auth to JWT

## Files Touched
- src/auth.ts
- src/session.ts

## Key Decisions
- Use JWT`,
      { ...facts, contractGoal: 'Rewrite auth to JWT' }
    )
    expect(result.ok).toBe(true)
  })

  it('round-trip: planted decision and write must appear in the summary or the gate fails', () => {
    const planted: ChatMessage[] = [
      { role: 'user', content: 'Ship src/auth/rewrite.ts' },
      assistantEdit('src/auth/rewrite.ts', 'e1'),
      toolOk('e1', 'edit'),
      ...askAnswer('q1', 'Use the planted-choice-9f3a')
    ]
    const extracted = extractFoldFacts(planted)
    expect(extracted.wroteFiles).toContain('src/auth/rewrite.ts')
    expect(extracted.decisions).toEqual(['Use the planted-choice-9f3a'])

    const amnesia = verifyCompactionSummary('## Session Intent\nDid some work', extracted)
    expect(amnesia.ok).toBe(false)
    expect(amnesia.failures.some((f) => f.kind === 'missing_decision')).toBe(true)
    expect(amnesia.failures.some((f) => f.kind === 'missing_wrote_file')).toBe(true)

    const faithful = verifyCompactionSummary(
      `## Session Intent
Ship auth rewrite

## Files Touched
- src/auth/rewrite.ts

## Key Decisions
- Use the planted-choice-9f3a`,
      extracted
    )
    expect(faithful.ok).toBe(true)
    expect(missingFactsFocus(amnesia, extracted)).toMatch(/planted-choice-9f3a/)
  })

  it('clips verify failure lines to the IPC event cap', () => {
    const lines = Array.from({ length: MAX_VERIFY_FAILURES + 4 }, (_, i) => `Invented path: f${i}.ts`)
    expect(clipVerifyFailures(lines)).toHaveLength(MAX_VERIFY_FAILURES)
  })
})

describe('recorded 81cf5721 verify_failed summary (19:05:40Z)', () => {
  const prefixFacts = {
    files: ['plan.md', 'contract.md', 'core/llm', '@modelcontextprotocol/sdk'],
    wroteFiles: ['plan.md', 'contract.md'],
    decisions: [CORE_DECISION, P5_DECISION],
    todos: [] as string[],
    doneWhen: [] as string[]
  }

  it('does not claim Next Steps directories, npm packages, or design-layer modules', () => {
    const claimed = extractClaimedPaths(RECORDED_SUMMARY)
    expect(claimed).toContain('plan.md')
    expect(claimed).toContain('contract.md')
    expect(claimed).not.toContain('@modelcontextprotocol/sdk')
    expect(claimed.some((p) => p.includes('referenced as dependency'))).toBe(false)
    expect(claimed).not.toContain('src/core/llm/')
    expect(claimed).not.toContain('src/core/agent/')
    expect(claimed).not.toContain('src/core/plugins/')
    expect(claimed).not.toContain('core/llm')
    expect(claimed).not.toContain('core/agent')
  })

  it('does not emit the recorded invented_path or missing_decision lines', () => {
    const result = verifyCompactionSummary(RECORDED_SUMMARY, prefixFacts, PREFIX_FOLDED_TEXT)
    expect(result.failures.filter((f) => f.kind === 'invented_path')).toEqual([])
    expect(result.failures.filter((f) => f.kind === 'missing_decision')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('matches Key Decisions after markdown/question-mark/em-dash folding', () => {
    const result = verifyCompactionSummary(
      RECORDED_SUMMARY,
      {
        files: ['plan.md', 'contract.md'],
        wroteFiles: ['plan.md', 'contract.md'],
        decisions: [
          `- ${CORE_DECISION}`,
          `- ${P5_DECISION}`
        ],
        todos: [],
        doneWhen: []
      },
      PREFIX_FOLDED_TEXT
    )
    expect(result.failures.some((f) => f.kind === 'missing_decision')).toBe(false)
  })

  it('stays fail-closed when a written file from the folded prefix is omitted', () => {
    const result = verifyCompactionSummary(
      RECORDED_SUMMARY,
      {
        ...prefixFacts,
        wroteFiles: [...prefixFacts.wroteFiles, 'src/auth/rewrite.ts']
      },
      PREFIX_FOLDED_TEXT
    )
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_wrote_file')).toBe(true)
  })
})

describe('recorded 81cf5721 verify_failed summary (02:18:32Z restated answers)', () => {
  it('does not emit the two Missing decision lines from the live banner', () => {
    const result = verifyCompactionSummary(RESTATED_KEY_DECISIONS, {
      files: [],
      wroteFiles: [],
      decisions: [CORE_DECISION, INTERFACE_DECISION],
      todos: [],
      doneWhen: []
    })
    expect(result.failures.filter((f) => f.kind === 'missing_decision')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('stays fail-closed when an ask_question prompt is absent', () => {
    const result = verifyCompactionSummary(RESTATED_KEY_DECISIONS, {
      files: [],
      wroteFiles: [],
      decisions: ['Planted unique prompt xyz?: secret-choice-9f3a'],
      todos: [],
      doneWhen: []
    })
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_decision')).toBe(true)
  })
})

describe('recorded d7dcdfbf low file coverage (29/77 need 39)', () => {
  const wroteFiles = [
    'src/cli/index.ts',
    'src/cli/config.ts',
    'src/core/config/store.ts',
    'src/core/llm/factory.ts',
    'src/index.ts',
    'tests/unit/config.test.ts',
    'tests/e2e/cli.test.ts',
    'out.txt'
  ]
  const inspectFiles = Array.from(
    { length: 77 },
    (_, i) => `src/read/file-${String(i).padStart(2, '0')}.ts`
  )
  const citedWrites = `## Session Intent
audit the entire codebase and current implementation and state end to end

## Files Touched
${wroteFiles.map((path) => `- \`${path}\``).join('\n')}

## Key Decisions
- Yes — full: interactive add/select + secure storage + provider flags`

  it('does not discard a write-complete summary for inspect-set coverage', () => {
    const result = verifyCompactionSummary(citedWrites, {
      files: inspectFiles,
      wroteFiles,
      decisions: [],
      todos: [],
      doneWhen: []
    })
    expect(result.failures.filter((f) => f.kind === 'low_file_coverage')).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('stays fail-closed when a written file is omitted', () => {
    const result = verifyCompactionSummary(citedWrites, {
      files: inspectFiles,
      wroteFiles: [...wroteFiles, 'tests/unit/config-ui.test.ts'],
      decisions: [],
      todos: [],
      doneWhen: []
    })
    expect(result.ok).toBe(false)
    expect(result.failures.some((f) => f.kind === 'missing_wrote_file')).toBe(true)
  })

  it('still requires coverage on a read-only fold, capped at FILE_COVERAGE_MAX_NEEDED', () => {
    const twoCited = `## Files Touched
- \`${inspectFiles[0]}\`
- \`${inspectFiles[1]}\``
    const low = verifyCompactionSummary(twoCited, {
      files: inspectFiles.slice(0, 14),
      wroteFiles: [],
      decisions: [],
      todos: [],
      doneWhen: []
    })
    expect(low.ok).toBe(false)
    expect(low.failures.some((f) => f.kind === 'low_file_coverage')).toBe(true)
    expect(low.failures[0]?.detail).toBe('2/14 files cited (need 7)')

    const eightCited = `## Files Touched
${inspectFiles.slice(0, FILE_COVERAGE_MAX_NEEDED).map((path) => `- \`${path}\``).join('\n')}`
    const capped = verifyCompactionSummary(eightCited, {
      files: inspectFiles,
      wroteFiles: [],
      decisions: [],
      todos: [],
      doneWhen: []
    })
    expect(capped.failures.filter((f) => f.kind === 'low_file_coverage')).toEqual([])
    expect(capped.ok).toBe(true)
  })
})

describe('requiredFoldFactsFocus', () => {
  it('lists written files on the first pass so the summarizer is told what to cite', () => {
    const focus = requiredFoldFactsFocus({
      files: ['src/auth.ts', 'src/session.ts'],
      wroteFiles: ['src/auth.ts'],
      decisions: ['Use JWT'],
      todos: [],
      doneWhen: [],
      contractGoal: 'Rewrite auth to JWT'
    })
    expect(focus).toMatch(/Written files that must appear/)
    expect(focus).toContain('src/auth.ts')
    expect(focus).toContain('Rewrite auth to JWT')
    expect(focus).toMatch(/Files from this history/)
  })
})

describe('successive fold: prior Files Touched vs new invented paths', () => {
  const prior = `## Session Intent
Earlier fold

## Files Touched
- src/old/a.ts`

  const merged = `${prior}

---

## Session Intent
Later fold

## Files Touched
- src/new/b.ts
- src/invented.ts`

  const newFacts = {
    files: ['src/new/b.ts'],
    wroteFiles: ['src/new/b.ts'],
    decisions: [] as string[],
    todos: [] as string[],
    doneWhen: [] as string[]
  }

  it('treats prior-summary paths as known when foldedText includes the prior summary', () => {
    const faithful = `${prior}

---

## Session Intent
Later fold

## Files Touched
- src/new/b.ts`

    const unknownPrior = verifyCompactionSummary(faithful, newFacts, 'edit src/new/b.ts')
    expect(unknownPrior.failures.some((f) => f.kind === 'invented_path')).toBe(true)

    const knownPrior = verifyCompactionSummary(
      faithful,
      newFacts,
      `${prior}\nedit src/new/b.ts`
    )
    expect(knownPrior.failures.filter((f) => f.kind === 'invented_path')).toEqual([])
    expect(knownPrior.ok).toBe(true)
  })

  it('still flags an invented path in a later Files Touched section', () => {
    const result = verifyCompactionSummary(merged, newFacts, `${prior}\nedit src/new/b.ts`)
    expect(result.ok).toBe(false)
    expect(
      result.failures.some((f) => f.kind === 'invented_path' && f.detail.includes('invented'))
    ).toBe(true)
  })
})

describe('d7dcdfbf Files Touched brace glob (08:13:30Z)', () => {
  const filesTouched = `## Files Touched
- **Created**: \`src/core/config/store.ts\`, \`src/core/llm/factory.ts\`, \`src/cli/config.ts\`, \`tests/unit/config.test.ts\`, \`tests/unit/config-ui.test.ts\`
- **Modified**: \`src/cli/index.ts\`, \`src/index.ts\`, \`tests/e2e/cli.test.ts\`
- **Verified**: \`src/core/agent/loop.ts\`, \`src/core/llm/{provider,openai,anthropic,fakellm}.ts\`, \`src/core/mcp/bridge.ts\`, \`package.json\`
- **Deleted**: \`out.txt\`, \`answers.txt\``

  it('expands brace globs into concrete files', () => {
    expect(expandBraceGlobs('src/core/llm/{provider,openai,anthropic,fakellm}.ts')).toEqual([
      'src/core/llm/provider.ts',
      'src/core/llm/openai.ts',
      'src/core/llm/anthropic.ts',
      'src/core/llm/fakellm.ts'
    ])
  })

  it('treats a brace glob as citing each written file', () => {
    expect(
      pathMentionedInText('src/core/llm/provider.ts', filesTouched)
    ).toBe(true)
    expect(
      pathMentionedInText('src/core/llm/fakellm.ts', filesTouched)
    ).toBe(true)
    const claimed = extractClaimedPaths(filesTouched)
    expect(claimed).toContain('src/core/llm/provider.ts')
    expect(claimed).toContain('src/core/config/store.ts')
    expect(claimed).not.toContain('src/core/llm/{provider,openai,anthropic,fakellm}.ts')
  })

  it('does not fail missing_wrote_file or low_file_coverage for the recorded card', () => {
    const wroteFiles = [
      'src/core/config/store.ts',
      'src/core/llm/factory.ts',
      'src/cli/config.ts',
      'src/cli/index.ts',
      'src/index.ts',
      'src/core/llm/provider.ts',
      'src/core/llm/openai.ts',
      'out.txt',
      'answers.txt'
    ]
    const files = [
      ...wroteFiles,
      'tests/unit/config.test.ts',
      'tests/unit/config-ui.test.ts',
      'tests/e2e/cli.test.ts',
      'src/core/agent/loop.ts',
      'src/core/llm/anthropic.ts',
      'src/core/llm/fakellm.ts',
      'src/core/mcp/bridge.ts',
      'package.json'
    ]
    const result = verifyCompactionSummary(filesTouched, {
      files,
      wroteFiles,
      decisions: [],
      todos: [],
      doneWhen: []
    })
    expect(result.failures.filter((f) => f.kind === 'missing_wrote_file')).toEqual([])
    expect(result.failures.filter((f) => f.kind === 'low_file_coverage')).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe('ask_question prompt: answer without a question mark', () => {
  it('matches a restated answer when the prompt did not end with ?', () => {
    const result = verifyCompactionSummary(
      '## Key Decisions\n- **Provider strategy**: OpenAI via a thin adapter',
      {
        files: [],
        wroteFiles: [],
        decisions: ['Provider strategy: Not sure — recommend one'],
        todos: [],
        doneWhen: []
      }
    )
    expect(result.failures.filter((f) => f.kind === 'missing_decision')).toEqual([])
    expect(result.ok).toBe(true)
  })
})
