import { describe, expect, it } from 'vitest'
import { FallbackBody } from '@renderer/features/chat/toolUi/bodies/McpBody'
import { BrowserSnapshotBody } from '@renderer/features/chat/toolUi/bodies/BrowserBody'
import { CodebaseSearchBody } from '@renderer/features/chat/toolUi/bodies/CodebaseSearchBody'
import {
  getToolBody,
  getToolEntry,
  getToolHeaderMeta,
  registeredBuiltinToolUiNames,
  toolHasBody
} from '@renderer/features/chat/toolUi/registry'
import type { UiToolRow } from '@shared/transcript'
import { AGENT_TOOLS } from '@main/agent/schemas/tools'

const FORMER_FALLBACK_TOOLS = [
  'browser_navigate',
  'browser_search',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_fill',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_wait_for_text',
  'browser_hover',
  'browser_handle_dialog',
  'browser_press_key',
  'browser_select_option',
  'diagnostics',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  'request_mcp_tools',
  'release_mcp_tools',
  'Skill',
  'ask_question',
  'switch_mode',
  'git_commit'
] as const

describe('tool UI registry coverage', () => {
  it('keeps a dedicated entry for every executable builtin plus replay-only web_* tools', () => {
    const registered = new Set(registeredBuiltinToolUiNames())
    const executable = new Set(AGENT_TOOLS.map((t) => t.name))
    for (const name of executable) {
      expect(registered.has(name), `missing UI registry entry for ${name}`).toBe(true)
    }
    // Intentional extras: transcript replay for deleted browser/web tools.
    expect(registered.has('web_fetch')).toBe(true)
    expect(registered.has('web_search')).toBe(true)
    const extras = [...registered].filter((n) => !executable.has(n)).sort()
    expect(extras).toEqual(['web_fetch', 'web_search'])
  })

  it('registers structured bodies for all former FallbackBody builtins', () => {
    for (const name of FORMER_FALLBACK_TOOLS) {
      expect(getToolBody(name)).not.toBe(FallbackBody)
      expect(getToolEntry(name).Body).not.toBe(FallbackBody)
    }
  })

  it('registers codebase_search with dedicated CodebaseSearchBody (not SearchBody/Fallback)', () => {
    expect(getToolBody('codebase_search')).toBe(CodebaseSearchBody)
    expect(getToolBody('codebase_search')).not.toBe(FallbackBody)
    expect(
      toolHasBody({
        id: 'c1',
        name: 'codebase_search',
        summary: 'q',
        status: 'done',
        argsPreview: JSON.stringify({ query: 'q' }),
        content: 'index: 1 chunks / 1 files · hits=0\n\nNo codebase_search hits.'
      })
    ).toBe(true)
  })

  it('renders browser_search with snapshot body (not plain action dump)', () => {
    expect(getToolBody('browser_search')).toBe(BrowserSnapshotBody)
    expect(getToolBody('browser_snapshot')).toBe(BrowserSnapshotBody)
    const meta = getToolHeaderMeta({
      id: 's1',
      name: 'browser_search',
      summary: 'exFAT BootChecksum',
      status: 'done',
      argsPreview: JSON.stringify({ query: 'exFAT BootChecksum' }),
      content: [
        'URL: https://duckduckgo.com/?q=exFAT',
        'Title: DuckDuckGo',
        'Interactive elements (use @eN with browser_click / browser_type):',
        '- @e1 role="link" name="Home" css="#logo"',
        '',
        'body'
      ].join('\n')
    })
    expect(meta.target).toBe('exFAT BootChecksum')
  })

  it('keeps unknown tools on content-only FallbackBody without args dump', () => {
    expect(getToolBody('totally_unknown_tool_xyz')).toBe(FallbackBody)
    const entry = getToolEntry('totally_unknown_tool_xyz')
    const tool: UiToolRow = {
      id: 't1',
      name: 'totally_unknown_tool_xyz',
      summary: '',
      status: 'done',
      argsPreview: JSON.stringify({ secret: true }),
      content: 'hello result'
    }
    expect(entry.hasBody(tool)).toBe(true)
    expect(
      entry.hasBody({
        ...tool,
        content: '',
        argsPreview: JSON.stringify({ only: 'args' })
      })
    ).toBe(false)
  })

  it('resolves header meta for Skill and MCP pin/release tools', () => {
    const skill: UiToolRow = {
      id: 's1',
      name: 'Skill',
      summary: 'code-review',
      status: 'done',
      content: '# Skill: code-review\n\nBody'
    }
    expect(getToolHeaderMeta(skill)).toMatchObject({
      verb: 'Loaded skill',
      target: 'code-review',
      icon: 'sparkles'
    })

    const pin: UiToolRow = {
      id: 'p1',
      name: 'request_mcp_tools',
      summary: '2 pinned',
      status: 'done',
      argsPreview: JSON.stringify({ serverId: 'gh' }),
      content: 'Pinned for next step (2): mcp__gh__a, mcp__gh__b'
    }
    expect(getToolHeaderMeta(pin)).toMatchObject({
      verb: 'Pinned MCP',
      target: 'gh',
      icon: 'plug'
    })
    expect(getToolEntry('request_mcp_tools').hasBody(pin)).toBe(true)

    const release: UiToolRow = {
      id: 'r1',
      name: 'release_mcp_tools',
      summary: '1 released',
      status: 'running',
      argsPreview: JSON.stringify({ tools: ['mcp__gh__a'] }),
      content: ''
    }
    expect(getToolHeaderMeta(release)).toMatchObject({
      verb: 'Releasing MCP',
      target: 'mcp__gh__a',
      icon: 'plug'
    })
  })

  it('lists mcp_list_tools in the header and hides empty resource/prompt bodies', () => {
    const listed: UiToolRow = {
      id: 'l1',
      name: 'mcp_list_tools',
      summary: '15 tools',
      status: 'done',
      content:
        '- mcp__filesystem__read_file readOnlyHint=true [omitted from this step catalog]: Read a file'
    }
    expect(getToolHeaderMeta(listed)).toMatchObject({
      verb: 'MCP tools',
      target: '1 tool',
      icon: 'plug'
    })
    expect(getToolEntry('mcp_list_tools').hasBody(listed)).toBe(true)

    const emptyResources: UiToolRow = {
      id: 'l2',
      name: 'mcp_list_resources',
      summary: 'none',
      status: 'done',
      content: 'No MCP resources connected.'
    }
    expect(getToolHeaderMeta(emptyResources)).toMatchObject({
      verb: 'MCP resources',
      target: 'none'
    })
    expect(getToolEntry('mcp_list_resources').hasBody(emptyResources)).toBe(false)
  })

  it('scrubs targets that duplicate the tool verb', () => {
    expect(
      getToolHeaderMeta({
        id: 'b1',
        name: 'browser_back',
        summary: 'back',
        status: 'done',
        content: 'ok'
      })
    ).toMatchObject({ verb: 'Back', target: '' })

    expect(
      getToolHeaderMeta({
        id: 'e1',
        name: 'edit',
        summary: 'edited',
        status: 'running',
        content: ''
      })
    ).toMatchObject({ verb: 'Editing', target: '' })
  })

  it('labels a new-file edit result as Created', () => {
    expect(
      getToolHeaderMeta({
        id: 'e2',
        name: 'edit',
        summary: 'src/new.ts',
        status: 'done',
        content: 'Created src/new.ts (12 chars)',
        argsPreview: JSON.stringify({ path: 'src/new.ts', contents: 'hello\n' })
      })
    ).toMatchObject({ verb: 'Created', target: 'new.ts' })
  })

  it('ask_question headerMeta uses summary not status chip', () => {
    expect(
      getToolHeaderMeta({
        id: 'a1',
        name: 'ask_question',
        summary: 'Diagnosing your empty screen',
        status: 'done',
        content:
          'Question timed out or was dismissed without answers. Continue with a reasonable default.'
      })
    ).toMatchObject({
      verb: 'Asked',
      target: 'Diagnosing your empty screen'
    })
  })

  it('todo_write headerMeta shows progress on success', () => {
    expect(
      getToolHeaderMeta({
        id: 'td1',
        name: 'todo_write',
        summary: '8 tasks',
        status: 'done',
        content: '4/8 complete\n[x] (1) Map architecture\n[~] (7) Benchmark'
      })
    ).toMatchObject({ verb: 'Updated tasks', target: '4/8 complete' })
  })

  it('todo_write headerMeta surfaces the validation error, not "2 tasks", on failure', () => {
    expect(
      getToolHeaderMeta({
        id: 'td2',
        name: 'todo_write',
        summary: '2 tasks',
        status: 'fail',
        content: 'todos.0.content: Required; todos.1.content: Required'
      })
    ).toMatchObject({ verb: 'Failed', target: 'todos.0.content: Required; todos.1.content: Required' })
  })

  it('todo_write headerMeta falls back to summary when failed content is empty', () => {
    expect(
      getToolHeaderMeta({
        id: 'td3',
        name: 'todo_write',
        summary: '2 tasks',
        status: 'fail',
        content: ''
      })
    ).toMatchObject({ target: '2 tasks' })
  })

  it('unknown tool fallback headerMeta omits path placeholder target', () => {
    expect(
      getToolHeaderMeta({
        id: 'w1',
        name: 'write_file_check',
        summary: 'placeholder',
        status: 'fail',
        content:
          'Unknown tool "write_file_check". Use edit or str_replace to change files.',
        argsPreview: JSON.stringify({ path: 'placeholder' })
      })
    ).toMatchObject({ target: '' })
  })

  it('does not treat chip-only ask_question/switch_mode as expandable', () => {
    const ask: UiToolRow = {
      id: 'a1',
      name: 'ask_question',
      summary: '',
      status: 'done',
      content: ''
    }
    const mode: UiToolRow = {
      id: 'm1',
      name: 'switch_mode',
      summary: '',
      status: 'done',
      content: ''
    }
    expect(getToolEntry('ask_question').hasBody(ask)).toBe(false)
    expect(getToolEntry('switch_mode').hasBody(mode)).toBe(false)
  })

  it('does not expand a normal delete receipt that repeats its compact row', () => {
    const deleted: UiToolRow = {
      id: 'd1',
      name: 'delete',
      summary: '.sv.js',
      status: 'done',
      argsPreview: JSON.stringify({ path: '.sv.js' }),
      content: 'Deleted .sv.js'
    }

    expect(getToolEntry('delete').hasBody(deleted)).toBe(false)
    expect(toolHasBody(deleted)).toBe(false)
  })

  it('does not show a completed delete receipt while the delete is still running', () => {
    const running: UiToolRow = {
      id: 'd-running',
      name: 'delete',
      summary: '.sv.js',
      status: 'running',
      argsPreview: JSON.stringify({ path: '.sv.js' }),
      content: ''
    }

    expect(toolHasBody(running)).toBe(false)
  })

  it('does not mount an empty edit peek while tool args are still chrome-only', () => {
    const chromeOnly: UiToolRow = {
      id: 'e-chrome',
      name: 'edit',
      summary: '',
      status: 'running',
      argsPreview: '',
      content: ''
    }
    const streaming: UiToolRow = {
      ...chromeOnly,
      id: 'e-json',
      argsPreview: '{'
    }
    expect(toolHasBody(chromeOnly)).toBe(false)
    expect(toolHasBody(streaming)).toBe(false)
  })

  it('does not expose a blank body for streaming file reads before content arrives', () => {
    const read: UiToolRow = {
      id: 'read-running',
      name: 'read',
      summary: 'package.json',
      status: 'running',
      argsPreview: JSON.stringify({ path: 'package.json' }),
      content: ''
    }
    const memoryRead: UiToolRow = {
      id: 'memory-read-running',
      name: 'memory_read',
      summary: 'NOTES.md',
      status: 'running',
      argsPreview: JSON.stringify({ path: 'NOTES.md' }),
      content: ''
    }

    expect(toolHasBody(read)).toBe(false)
    expect(toolHasBody(memoryRead)).toBe(false)
  })

  it('does not expose empty result bodies before output arrives', () => {
    const outputTools = [
      'search',
      'glob',
      'grep',
      'codebase_search',
      'list_dir',
      'web_fetch',
      'web_search',
      'memory_list',
      'Skill',
      'diagnostics',
      'git_status',
      'git_diff',
      'mcp_list_tools',
      'request_mcp_tools'
    ]
    for (const name of outputTools) {
      expect(
        toolHasBody({
          id: `${name}-running`,
          name,
          summary: 'query',
          status: 'running',
          argsPreview: JSON.stringify({ query: 'query', path: 'src', serverId: 'srv' }),
          content: ''
        }),
        name
      ).toBe(false)
    }
  })

  it('keeps additional delete details expandable', () => {
    const recursive: UiToolRow = {
      id: 'd2',
      name: 'delete',
      summary: 'dist',
      status: 'done',
      argsPreview: JSON.stringify({ path: 'dist', recursive: true }),
      content: 'Deleted dist'
    }

    expect(getToolEntry('delete').hasBody(recursive)).toBe(true)
  })

  it('sets git_diff filePath from content headers when args omit path', () => {
    const meta = getToolHeaderMeta({
      id: 'g1',
      name: 'git_diff',
      summary: 'git diff',
      status: 'done',
      content: ['--- a/index.html', '+++ b/index.html', '@@', '-a', '+b'].join('\n')
    })
    expect(meta.filePath).toBe('index.html')
    expect(meta.icon).toBeUndefined()
  })
})
