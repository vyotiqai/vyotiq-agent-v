import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { AGENT_TOOLS, AWAIT_AGENT_INSTANCE_MAX_MS, BUILTIN_TOOL_NAMES, validateToolArgs } from '@main/agent/schemas/tools'
import { BUILTIN_HANDLERS } from '@main/agent/tools'
import {
  DEFAULT_NAV_TIMEOUT_MS,
  DEFAULT_SNAPSHOT_CHARS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_NAV_TIMEOUT_MS,
  MAX_TYPE_CHARS,
  SETTLE_FALLBACK_MS
} from '@main/app/browserUrl'
import { estimateTextTokens } from '@main/agent/context/estimate'
import { BUDGET_SHARES } from '@main/agent/context/types'

const SECTION_HEADERS = [
  'WHEN TO USE:',
  'WORKFLOW:',
  'AVOID:',
  'LIMITS:',
  'RESULT:',
  'EXECUTION POLICY:'
] as const

describe('toolsSchema', () => {
  it('tells file and web tools how to cite this-turn evidence', () => {
    for (const name of ['read', 'grep', 'search', 'codebase_search'] as const) {
      const tool = AGENT_TOOLS.find((t) => t.name === name)
      expect(tool?.description, name).toContain('[[path]]')
    }
    for (const name of ['browser_search', 'browser_navigate', 'browser_snapshot'] as const) {
      const tool = AGENT_TOOLS.find((t) => t.name === name)
      expect(tool?.description, name).toContain('[[https://url]]')
    }
  })

  it('covers every executable built-in with a short description', () => {
    const names = AGENT_TOOLS.map((t) => t.name).sort()
    expect(names).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(names.length).toBe(60)
    expect(names).toEqual(
      expect.arrayContaining([
        'github_pr_create',
        'github_pr_review',
        'github_issue',
        'edit_notebook',
        'lsp',
        'create_goal',
        'update_goal'
      ])
    )

    for (const tool of AGENT_TOOLS) {
      expect(tool.description.trim().length, `${tool.name} empty description`).toBeGreaterThan(0)
      for (const section of SECTION_HEADERS) {
        expect(tool.description, `${tool.name} has structured section ${section}`).not.toContain(
          section
        )
      }
    }
  })

  it('wires a real handler for every built-in tool (no missing/stub handlers)', () => {
    const handlerNames = Object.keys(BUILTIN_HANDLERS).sort()
    expect(handlerNames).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(handlerNames).toHaveLength(60)
    for (const name of BUILTIN_TOOL_NAMES) {
      const handler = BUILTIN_HANDLERS[name as keyof typeof BUILTIN_HANDLERS]
      expect(typeof handler, `${name} handler must be a function`).toBe('function')
    }
  })

  it('keeps read optional param descriptions in JSON Schema', () => {
    const read = AGENT_TOOLS.find((t) => t.name === 'read')
    expect(read).toBeDefined()
    expect(read!.description).toMatch(/omit offset\/limit/i)
    expect(read!.description).toMatch(/byte window, not lines/i)
    expect(read!.description).toMatch(/\.docx/)
    expect(read!.description).toMatch(/extracted document text/i)
    expect(read!.description).toMatch(/do not unzip/i)
    const props = (read!.parameters as { properties: Record<string, { description?: string }> })
      .properties
    expect(props.startLine?.description).toMatch(/Prefer this over offset\/limit/)
    expect(props.endLine?.description).toBeTruthy()
    expect(props.offset?.description).toMatch(/not a line number/)
    expect(props.offset?.description).toMatch(/Omit when using startLine\/endLine/)
    expect(props.limit?.description).toMatch(/Bytes, not lines/)
  })

  it('emits memory_list with required:[] for OpenAI strict mode', () => {
    const mem = AGENT_TOOLS.find((t) => t.name === 'memory_list')
    expect(mem).toBeDefined()
    expect((mem!.parameters as { required?: string[] }).required).toEqual([])
  })

  it('does not register compact_context (auto + menu compact only)', () => {
    expect(AGENT_TOOLS.find((t) => t.name === 'compact_context')).toBeUndefined()
  })

  it('describes terminal as builds/CLI not file inspection', () => {
    const terminal = AGENT_TOOLS.find((t) => t.name === 'terminal')
    expect(terminal).toBeDefined()
    expect(terminal!.description).toMatch(/shell command/i)
    expect(terminal!.description).toMatch(/not for cat\/type\/findstr/i)
    expect(terminal!.description).toMatch(/keeps running|session_id/i)
    expect(terminal!.description).not.toMatch(/Command timed out/i)
    expect(terminal!.description).not.toMatch(/Settings → Tools/)
    const termProps = (
      terminal!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    expect(termProps.command?.description).not.toMatch(/Settings → Tools/)
    expect(termProps.timeoutMs?.description).toMatch(/New-command wait/)
    expect(termProps.working_directory?.description).toMatch(/Ignored when polling/)
  })

  it('presents codebase_search as the default way to locate code, grep for exhaustive/regex', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'codebase_search')
    expect(tool).toBeDefined()
    // Locating unseen code is the common case: the ranked hybrid search is the
    // default probe. The old wording reserved it for rare conceptual asks and
    // steered every symbol-aware query to grep.
    expect(tool!.description).toMatch(/default way to locate code/i)
    expect(tool!.description).not.toMatch(/conceptual/i)
    expect(tool!.description).toMatch(/grep/)
    expect(tool!.description).toMatch(/docs\//)
    expect(tool!.description).toMatch(/search time/i)
    expect(tool!.description).not.toMatch(/nomic-embed/i)
    const props = (
      tool!.parameters as {
        properties: { query?: { description?: string }; mode?: { description?: string } }
      }
    ).properties
    expect(props.query?.description).toMatch(/camelCase/i)
    expect(props.query?.description).not.toMatch(/use grep for every exact symbol occurrence/i)
    expect(props.mode?.description).toMatch(/lexical/i)
    expect(props.mode?.description).toMatch(/symbol/i)
  })

  it('owns browser @eN freshness and ask_question stacking in tool schemas', () => {
    const snap = AGENT_TOOLS.find((t) => t.name === 'browser_snapshot')
    const nav = AGENT_TOOLS.find((t) => t.name === 'browser_navigate')
    const ask = AGENT_TOOLS.find((t) => t.name === 'ask_question')
    const request = AGENT_TOOLS.find((t) => t.name === 'request_mcp_tools')
    expect(snap!.description).toMatch(/@eN/)
    expect(snap!.description).toMatch(/untrusted/i)
    expect(nav!.description).toMatch(/invalidates prior refs/i)
    expect(request!.description).toMatch(/built-in|MCP/i)
    expect(ask!.description).toMatch(/prefer 1–2|prefer 1-2/i)
  })

  it('emits todo_write status as a string enum', () => {
    const todo = AGENT_TOOLS.find((t) => t.name === 'todo_write')
    expect(todo).toBeTruthy()
    expect(todo!.description).toMatch(/merge/i)
    expect(todo!.description).toMatch(/in_progress/)
    expect(todo!.description).toMatch(/demoted to pending/)
    expect(todo!.description).not.toMatch(/before edit, str_replace, delete, or terminal/)
    const status = (
      todo!.parameters as {
        properties: { todos: { items: { properties: { status: Record<string, unknown> } } } }
      }
    ).properties.todos.items.properties.status
    expect(status.type).toBe('string')
    expect(status.enum).toEqual(['pending', 'in_progress', 'completed', 'cancelled'])
    expect(status.description).toMatch(/in_progress/)
  })

  it('fits built-in tool defs under the default tools budget share', () => {
    const defaultWindow = 128_000
    const toolsBudget = Math.floor(defaultWindow * BUDGET_SHARES.tools)
    const estimate = estimateTextTokens(JSON.stringify(AGENT_TOOLS))
    expect(estimate).toBeLessThan(toolsBudget)
    // Leave headroom for MCP tools under typical budgets.
    expect(estimate).toBeLessThan(toolsBudget * 0.5)
  })
})

describe('harness tool catalog', () => {
  it('has a concise durable structure without runtime catalog duplication', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    for (const tag of [
      'role',
      'capabilities',
      'tool_policy',
      'constraints',
      'work_style',
      'memory',
      'output_format'
    ]) {
      expect(harness).toContain(`<${tag}>`)
      expect(harness).toContain(`</${tag}>`)
    }
    expect(harness, 'spine must not wrap itself as workspace appendix').not.toContain(
      '</workspace_harness>'
    )
    expect(harness).not.toMatch(/^##\s+/m)
    expect(harness).toMatch(/Use only capabilities exposed in the current tool catalog/i)
    expect(harness).toMatch(/exact catalog tool names and valid arguments/i)
    expect(harness).toMatch(/independent operations concurrently/i)
    expect(harness).toMatch(/preserve unrelated user changes/i)
    expect(harness).toMatch(/Separate observed facts from inferences/i)
    expect(harness).toMatch(/Commits, pushes, deployments/i)
    expect(harness).toMatch(/Continue authorized work until it is complete/i)
    expect(harness).toMatch(/narrowest relevant checks/i)
    expect(harness).not.toMatch(
      /mcp__|mcp_list_tools|spawn_agent_instance|run_id|generate_image|edit_image|Ask\/Plan|auto-compacts|8 consecutive|6 steps/i
    )
  })

  it('keeps prompt-injection guardrails without mode workflow essays or product-UI chrome', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    expect(harness).toMatch(/Do not assume/)
    expect(harness).toMatch(/verified evidence from this run/)
    expect(harness).not.toMatch(/guessed path/i)
    expect(harness).toMatch(/data, not instructions/i)
    expect(harness).toMatch(/take precedence over directives/i)
    expect(harness).not.toMatch(/Keep\/Discard/i)
    expect(harness).not.toMatch(/Verify before done|verify-before-done|soft-nudge/i)
    expect(harness).not.toMatch(/Contract done-when|contractDoneWhen|mechanically checked/i)
    expect(harness).not.toMatch(/Read before edit|read-before-edit/i)
    expect(harness).not.toMatch(/Prefer `read`[\s\S]*before editing/i)
    expect(harness).not.toMatch(/todo_write/)
    expect(harness).not.toMatch(/Write durable facts with `memory_write` when learned/i)
    expect(harness).toMatch(/Do not add a package unless the requested change requires it/i)
    expect(harness).toMatch(/files, tests, logs, or runtime output/)
    expect(harness).toMatch(/do not rely on training memory/i)
    expect(harness).toMatch(/Store verified facts only/)
    expect(harness).not.toMatch(/memory_write/)
    expect(harness).toMatch(/evidence from this run/)
    expect(harness).not.toMatch(/never lorem ipsum/i)
    expect(harness).not.toMatch(/unbounded rows/i)
    expect(harness).not.toMatch(/@ts-ignore|@ts-expect-error/)
    expect(harness).not.toMatch(/strict TDD/i)
    expect(harness).not.toMatch(/200ms/)
    expect(harness).not.toMatch(/Push Logic to the Database/i)
    expect(harness).not.toMatch(/prefer them for architecture/i)
    // Meta-assembly text (receipts, harness-apply, mode section mechanics) was moved to the handbook.
    expect(harness).not.toMatch(/receipt\.json/i)
    expect(harness).not.toMatch(/harness-review|harness\/proposals/i)
    expect(harness).not.toMatch(/harness-apply/i)
    expect(harness).not.toMatch(/not unsupervised Self-Harness|human review scaffold/i)
    expect(harness).not.toMatch(/normal PR/i)
    // The harness may legitimately mention "mode section" in tool policy (MCP meta-tools); the meta-assembly paragraph is gone.
    expect(harness).not.toMatch(/or graph search/)
    // Mode-specific diagnostics / terminal rules live in modeSectionMarkdown.
    expect(harness).not.toMatch(/Ask mode[\s\S]*no `diagnostics`/i)
    expect(harness).not.toMatch(/In Plan mode you may use `diagnostics`/i)
    // Concurrency / serial / approval are runtime-enforced (classify + executeStepTools).
    expect(harness).not.toMatch(/capped at 4/i)
    expect(harness).not.toMatch(/at most 2 concurrent/i)
    expect(harness).not.toMatch(/approval-gated|approval-exempt/i)
  })

  it('keeps the bundled spine under the token ceiling', () => {
    const harnessPath = join(process.cwd(), 'resources', 'harness', 'default.md')
    const harness = readFileSync(harnessPath, 'utf8')
    expect(estimateTextTokens(harness)).toBeLessThan(2000)
  })

  it.skipIf(!existsSync(join(process.cwd(), 'docs', 'harness-handbook.md')))(
    'documents canonical harness ownership outside the runtime harness',
    () => {
    const harnessPath = join(process.cwd(), 'docs', 'harness-handbook.md')
    const handbook = readFileSync(harnessPath, 'utf8')
    expect(handbook).toMatch(/resources\/harness\/default\.md.*canonical first-party harness/i)
    expect(handbook).toMatch(/Word documents are reference copies, not runtime policy sources/i)
    expect(handbook).toMatch(/Build and install commands do not regenerate the canonical harness/i)
    expect(handbook).toMatch(/tool names, arguments, limits, and usage details/i)
    expect(handbook).toMatch(/runtime thresholds/i)
    expect(handbook).toMatch(/Stable system order:[\s\S]*Workspace rules/i)
    expect(handbook).toMatch(/Memory files are not injected automatically/i)
    expect(handbook).toMatch(/workspace_harness/)
    expect(handbook).toMatch(/untrusted preferences/i)
    expect(handbook).toMatch(/never replaces the first-party harness/i)
    expect(handbook).toMatch(/harness-apply/i)
    expect(handbook).toMatch(/normal code change/i)
    expect(handbook).toMatch(/compaction use dedicated prompts/i)
    expect(handbook).not.toMatch(/harness rewriting/i)
    expect(handbook).toMatch(/does not rewrite the spine with a model/i)
    expect(handbook).toMatch(/proposed body starts as the current canonical harness/i)
    }
  )

  it('defaults await_agent_instance timeout_ms without a maximum clamp', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'await_agent_instance')
    expect(tool).toBeDefined()
    const timeout = (
      tool!.parameters as { properties: Record<string, { minimum?: number; maximum?: number; description?: string }> }
    ).properties.timeout_ms
    expect(timeout.minimum).toBe(1_000)
    expect(timeout.maximum).toBeUndefined()
    expect(timeout.description).toContain(String(AWAIT_AGENT_INSTANCE_MAX_MS))
    expect(
      validateToolArgs(
        'await_agent_instance',
        JSON.stringify({ run_id: 'child-1', timeout_ms: AWAIT_AGENT_INSTANCE_MAX_MS + 1 })
      ).ok
    ).toBe(true)
  })

  it('describes spawn as an independent workstream and rejects whitespace-only goals at Zod', () => {
    const spawn = AGENT_TOOLS.find((t) => t.name === 'spawn_agent_instance')
    expect(spawn).toBeDefined()
    expect(spawn!.description).toMatch(/independent workstream/)
    expect(spawn!.description).toMatch(/Batch multiple spawns in one step/)
    expect(spawn!.description).toMatch(/then await those run_ids together in one step/)
    const goal = (
      spawn!.parameters as { properties: Record<string, { description?: string }> }
    ).properties.goal
    expect(goal.description).toMatch(/child-only user prompt/i)
    expect(goal.description).toMatch(/sub-tasks/)
    expect(goal.description).toMatch(/no parent transcript/i)
    expect(
      validateToolArgs(
        'spawn_agent_instance',
        JSON.stringify({ goal: '   ', outcome: 'o', sub_tasks: ['a'], done_when: 'd' })
      ).ok
    ).toBe(false)
    expect(
      validateToolArgs(
        'spawn_agent_instance',
        JSON.stringify({
          goal: 'audit src/main',
          outcome: 'o',
          sub_tasks: ['a'],
          done_when: 'd',
        })
      ).ok
    ).toBe(true)
  })

  it('describes await as waiting those run_ids together in one step', () => {
    const awaitTool = AGENT_TOOLS.find((t) => t.name === 'await_agent_instance')
    expect(awaitTool).toBeDefined()
    expect(awaitTool!.description).toMatch(/summary/)
    expect(awaitTool!.description).toMatch(/Await multiple run_ids together in one step/)
  })

  it('describes search as text-only without a skip-size cap', () => {
    const search = AGENT_TOOLS.find((t) => t.name === 'search')
    expect(search).toBeDefined()
    expect(search!.description).toMatch(/Word \.docx/)
    expect(search!.description).toMatch(/extracted text/)
    expect(search!.description).not.toMatch(/256 KB/)
    expect(search!.description).not.toMatch(/512 KB/)
  })

  it('describes grep as text-only without a skip-size cap', () => {
    const grep = AGENT_TOOLS.find((t) => t.name === 'grep')
    expect(grep).toBeDefined()
    expect(grep!.description).toMatch(/Word \.docx/)
    expect(grep!.description).toMatch(/extracted text/)
    expect(grep!.description).not.toMatch(/KB are skipped/)
  })

  it('emits codebase_search maxResults without a maximum', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'codebase_search')
    expect(tool).toBeDefined()
    const maxResults = (
      tool!.parameters as { properties: Record<string, { maximum?: number }> }
    ).properties.maxResults
    expect(maxResults.maximum).toBeUndefined()
  })

  it('keeps handler-true descriptions for delete, list_dir, git_commit, ask, diagnostics', () => {
    const byName = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t.description]))
    expect(byName.delete).toMatch(/non-empty directory/)
    expect(byName.list_dir).toMatch(/Gitignore/)
    expect(byName.list_dir).toMatch(/workspace root/)
    expect(byName.glob).toMatch(/workspace root/)
    expect(byName.git_commit).toMatch(/paths is omitted/)
    expect(byName.ask_question).toMatch(/Never call with \{\}/)
    expect(byName.diagnostics).toMatch(/no override command/)
  })

  it('emits memory_write contents without a maxLength', () => {
    const tool = AGENT_TOOLS.find((t) => t.name === 'memory_write')
    expect(tool).toBeDefined()
    const contents = (
      tool!.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.contents
    expect(contents.maxLength).toBeUndefined()
    expect(tool!.description).not.toMatch(/64 KiB/)
    expect(
      validateToolArgs(
        'memory_write',
        JSON.stringify({ path: 'index.md', contents: 'x'.repeat(80_000) })
      ).ok
    ).toBe(true)
  })

  it('emits nav and wait timeoutMs without a maximum clamp', () => {
    const nav = AGENT_TOOLS.find((t) => t.name === 'browser_navigate')
    const wait = AGENT_TOOLS.find((t) => t.name === 'browser_wait_for_selector')
    const navTimeout = (
      nav!.parameters as { properties: Record<string, { maximum?: number }> }
    ).properties.timeoutMs
    const waitTimeout = (
      wait!.parameters as { properties: Record<string, { maximum?: number }> }
    ).properties.timeoutMs
    expect(navTimeout.maximum).toBeUndefined()
    expect(waitTimeout.maximum).toBeUndefined()
    expect(
      validateToolArgs(
        'browser_navigate',
        JSON.stringify({ url: 'https://example.com', timeoutMs: MAX_NAV_TIMEOUT_MS + 1 })
      ).ok
    ).toBe(true)
  })

  it('rejects empty search/glob/grep patterns at Zod', () => {
    expect(validateToolArgs('search', JSON.stringify({ query: '' })).ok).toBe(false)
    expect(validateToolArgs('glob', JSON.stringify({ pattern: '' })).ok).toBe(false)
    expect(validateToolArgs('grep', JSON.stringify({ pattern: '' })).ok).toBe(false)
    expect(validateToolArgs('search', JSON.stringify({ query: '   ' })).ok).toBe(false)
    expect(validateToolArgs('glob', JSON.stringify({ pattern: '   ' })).ok).toBe(false)
    expect(validateToolArgs('grep', JSON.stringify({ pattern: '   ' })).ok).toBe(false)
  })

  it('rejects duplicate top-level path keys before JSON last-wins', () => {
    const result = validateToolArgs(
      'read',
      '{"path":"murmur-youtube-main/windows/global.json","path":"murmur-youtube-main/windows/Directory.Build.props"}'
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/Duplicate JSON key "path"/)
    expect(result.error).toContain('murmur-youtube-main/windows/global.json')
    expect(result.error).toContain('murmur-youtube-main/windows/Directory.Build.props')
  })

  it('rejects empty required paths and browser_navigate URLs at Zod', () => {
    expect(validateToolArgs('read', JSON.stringify({ path: '' })).ok).toBe(false)
    expect(validateToolArgs('memory_read', JSON.stringify({ path: '   ' })).ok).toBe(false)
    expect(validateToolArgs('browser_navigate', JSON.stringify({ url: '' })).ok).toBe(false)
  })

  it('rejects whitespace-only required browser selectors, keys, and MCP ids', () => {
    expect(validateToolArgs('browser_click', JSON.stringify({ selector: '   ' })).ok).toBe(false)
    expect(validateToolArgs('browser_press_key', JSON.stringify({ key: '   ' })).ok).toBe(false)
    expect(
      validateToolArgs('mcp_read_resource', JSON.stringify({ serverId: '   ', uri: 'file://x' })).ok
    ).toBe(false)
  })

  it('describes settle and nav/wait defaults from the same browser constants', () => {
    const click = AGENT_TOOLS.find((t) => t.name === 'browser_click')
    const nav = AGENT_TOOLS.find((t) => t.name === 'browser_navigate')
    const wait = AGENT_TOOLS.find((t) => t.name === 'browser_wait_for_selector')
    const clickProps = (
      click!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    const navProps = (
      nav!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    const waitProps = (
      wait!.parameters as { properties: Record<string, { description?: string }> }
    ).properties
    expect(clickProps.settleMs?.description).toContain(String(SETTLE_FALLBACK_MS))
    expect(navProps.timeoutMs?.description).toContain(String(DEFAULT_NAV_TIMEOUT_MS))
    expect(waitProps.timeoutMs?.description).toContain(String(DEFAULT_WAIT_TIMEOUT_MS))
  })

  it('rejects browser_tabs select without tab_id', () => {
    const result = validateToolArgs('browser_tabs', JSON.stringify({ action: 'select' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/tab_id is required/)
  })

  it('emits browser_type/fill without a maxLength', () => {
    const type = AGENT_TOOLS.find((t) => t.name === 'browser_type')
    const fill = AGENT_TOOLS.find((t) => t.name === 'browser_fill')
    const typeText = (
      type!.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.text
    const fillValue = (
      fill!.parameters as { properties: Record<string, { maxLength?: number }> }
    ).properties.value
    expect(typeText.maxLength).toBeUndefined()
    expect(fillValue.maxLength).toBeUndefined()
    expect(
      validateToolArgs(
        'browser_type',
        JSON.stringify({ text: 'x'.repeat(MAX_TYPE_CHARS + 1) })
      ).ok
    ).toBe(true)
  })

  it('emits snapshot maxChars default matching DEFAULT_SNAPSHOT_CHARS', () => {
    const snap = AGENT_TOOLS.find((t) => t.name === 'browser_snapshot')
    expect(snap).toBeDefined()
    const maxChars = (
      snap!.parameters as { properties: Record<string, { description?: string }> }
    ).properties.maxChars
    expect(maxChars.description).toContain(String(DEFAULT_SNAPSHOT_CHARS))
  })

  it('prefers line-range when offset/limit are also passed', () => {
    const mixed = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', startLine: 1, endLine: 10, offset: 1, limit: 240 })
    )
    expect(mixed.ok).toBe(true)
    if (!mixed.ok) return
    expect(mixed.data.startLine).toBe(1)
    expect(mixed.data.endLine).toBe(10)
    expect(mixed.data.offset).toBeUndefined()
    expect(mixed.data.limit).toBeUndefined()

    const offsetZero = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', startLine: 1, offset: 0 })
    )
    expect(offsetZero.ok).toBe(true)
    if (!offsetZero.ok) return
    expect(offsetZero.data.startLine).toBe(1)
    expect(offsetZero.data.offset).toBeUndefined()
  })

  it('swaps inverted startLine/endLine instead of failing', () => {
    const swapped = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', startLine: 20, endLine: 5 })
    )
    expect(swapped.ok).toBe(true)
    if (!swapped.ok) return
    expect(swapped.data.startLine).toBe(5)
    expect(swapped.data.endLine).toBe(20)
  })

  it('treats offset 0 with no limit as unset and keeps a real byte window', () => {
    const noop = validateToolArgs('read', JSON.stringify({ path: 'a.ts', offset: 0 }))
    expect(noop.ok).toBe(true)
    if (!noop.ok) return
    expect(noop.data.offset).toBeUndefined()
    expect(noop.data.limit).toBeUndefined()

    const fromStart = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', offset: 0, limit: 20 })
    )
    expect(fromStart.ok).toBe(true)
    if (!fromStart.ok) return
    expect(fromStart.data.offset).toBe(0)
    expect(fromStart.data.limit).toBe(20)

    const window = validateToolArgs(
      'read',
      JSON.stringify({ path: 'a.ts', offset: 10, limit: 20 })
    )
    expect(window.ok).toBe(true)
    if (!window.ok) return
    expect(window.data.offset).toBe(10)
    expect(window.data.limit).toBe(20)
    expect(window.data.startLine).toBeUndefined()
  })

  it('accepts terminal command together with session_id (command wins)', () => {
    const result = validateToolArgs(
      'terminal',
      JSON.stringify({
        command: 'echo hi',
        session_id: 'e8b8f89f-1b26-4c5b-a1dd-a93800d05fbb',
        pattern: ''
      })
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.command).toBe('echo hi')
    expect(result.data.session_id).toBeUndefined()
    expect(result.data.pattern).toBeUndefined()
  })

  it('rejects request_mcp_tools and release_mcp_tools without tools or serverId', () => {
    const request = validateToolArgs('request_mcp_tools', '{}')
    const release = validateToolArgs('release_mcp_tools', '{}')
    expect(request.ok).toBe(false)
    expect(release.ok).toBe(false)
    if (!request.ok) expect(request.error).toMatch(/tools: string\[\] and\/or serverId/)
    if (!release.ok) expect(release.error).toMatch(/tools: string\[\] and\/or serverId/)
  })

  it('rejects whitespace-only git_commit messages at Zod', () => {
    const result = validateToolArgs('git_commit', JSON.stringify({ message: '   ' }))
    expect(result.ok).toBe(false)
  })

  it('accepts memory_write contents of any size at Zod', () => {
    const result = validateToolArgs(
      'memory_write',
      JSON.stringify({ path: 'index.md', contents: 'x'.repeat(80_000) })
    )
    expect(result.ok).toBe(true)
  })

  it('rejects paused on update_goal and accepts active or complete', () => {
    expect(validateToolArgs('update_goal', JSON.stringify({ status: 'paused' })).ok).toBe(false)
    expect(validateToolArgs('update_goal', JSON.stringify({ status: 'complete' })).ok).toBe(true)
    expect(validateToolArgs('update_goal', JSON.stringify({ status: 'active' })).ok).toBe(true)
    expect(validateToolArgs('create_goal', JSON.stringify({ objective: 'fix flaky tests' })).ok).toBe(
      true
    )
  })

  it('spawn_agent_instance schema states the brief contract and batch semantics', () => {
    const spawn = AGENT_TOOLS.find((t) => t.name === 'spawn_agent_instance')
    expect(spawn).toBeDefined()
    expect(spawn!.description).toMatch(/independent workstream/i)
    expect(spawn!.description).toMatch(/fanning them out across instances/i)
    expect(spawn!.description).toMatch(/no child is overloaded/i)
    expect(spawn!.description).toMatch(/spawned zero instances/)
    expect(spawn!.description).toMatch(/child never sees this conversation/i)
    expect(spawn!.description).toMatch(/worktree branch/i)
    expect(spawn!.description).toMatch(/run_ids together in one step/i)
    expect(spawn!.description).toMatch(/structured brief — outcome, sub_tasks, done_when/)
    const awaitTool = AGENT_TOOLS.find((t) => t.name === 'await_agent_instance')
    expect(awaitTool!.description).toMatch(/run_ids together in one step/i)
    expect(awaitTool!.description).toMatch(/On timeout the child keeps running/i)
    const validBrief = validateToolArgs(
      'spawn_agent_instance',
      JSON.stringify({ goal: 'g', outcome: 'o', sub_tasks: ['a'], done_when: 'd' })
    )
    expect(validBrief.ok).toBe(true)
    const missingFieldCases: [string, Record<string, unknown>][] = [
      ['outcome', { goal: 'g', sub_tasks: ['a'], done_when: 'd' }],
      ['sub_tasks', { goal: 'g', outcome: 'o', done_when: 'd' }],
      ['done_when', { goal: 'g', outcome: 'o', sub_tasks: ['a'] }]
    ]
    for (const [field, args] of missingFieldCases) {
      const result = validateToolArgs('spawn_agent_instance', JSON.stringify(args))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain(field)
    }
    const emptySubTasks = validateToolArgs(
      'spawn_agent_instance',
      JSON.stringify({ goal: 'g', outcome: 'o', sub_tasks: [], done_when: 'd' })
    )
    expect(emptySubTasks.ok).toBe(false)
  })

  it('merge_agent_instance documents merge constraints', () => {
    const merge = AGENT_TOOLS.find((t) => t.name === 'merge_agent_instance')
    expect(merge!.description).toMatch(/one branch at a time/i)
    expect(merge!.description).toMatch(/one branch at a time/i)
  })
})
