/**
 * E2E coverage for evidence-only screenshot/transcript audit (T1/T2/R1).
 * Drives real executeTool / terminal / edit paths, then transcript → UI adapters.
 * No Electron GUI (see tests/gui-e2e for Playwright).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-e2e-audit-settings-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null,
  createWindow: () => undefined,
  applyTitleBarTheme: () => undefined
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS, autoModeSwitch: true })
}))

import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { toolTerminal } from '@main/agent/tools/terminal'
import {
  appendAssistantWithTools,
  appendToolResult
} from '@shared/chatHistory'
import type { ChatMessage } from '@shared/ipc'
import { messagesToUiItems } from '@shared/transcript'
import { shouldShowTaskBoundaryTip } from '@shared/utils/tokenCost'
import { mapToolGroupProps } from '@renderer/features/chat/utils/toolGroupAdapter'
import { parseStatusMessageData } from '@renderer/features/chat/toolUi/parsers/status'
import { parseDiffPreview, parseUnifiedDiff } from '@renderer/features/chat/toolUi/parsers/edit'
import { getToolHeaderMeta } from '@renderer/features/chat/toolUi/registry'
import { toolLabel } from '@renderer/features/chat/toolUi/meta'
import { toolDefaultExpanded } from '@renderer/features/chat/toolUi/shells'
import type { UiToolRow } from '@shared/transcript'

/** Exact T1 malformed questions string (unescaped quotes → JSON.parse throws). */
const T1_MALFORMED_QUESTIONS =
  '[{"id": "how_open", "prompt": "How?", "type": "single", "options": ["A VS Code "Live Server" or similar", "Other"]}]'

const T1_TIMEOUT_CONTENT =
  'Question timed out or was dismissed without answers. Continue with a reasonable default.'

const T1_BASH_FOR =
  'node --version 2>&1; for f in js/setup.js js/audio.js js/input.js js/particles.js js/entities.js js/flow.js js/game.js; do node --check "$f" && echo "OK $f"; done'

const T1_INDEX_HTML = [
  '  <script src="js/audio.js"></script>',
  '  <script src="js/input.js"></script>',
  '  <script src="js/particles.js"></script>',
  '  <script src="js/game.js"></script>',
  ''
].join('\n')

const T1_BARE_DIFF = [
  '@@',
  '-  <script src="js/audio.js"></script>',
  '-  <script src="js/input.js"></script>',
  '-  <script src="js/particles.js"></script>',
  '-  <script src="js/game.js"></script>',
  '+  <script src="js/setup.js"></script>',
  '+  <script src="js/audio.js"></script>',
  '+  <script src="js/input.js"></script>',
  '+  <script src="js/particles.js"></script>',
  '+  <script src="js/entities.js"></script>',
  '+  <script src="js/flow.js"></script>',
  '+  <script src="js/game.js"></script>',
  ''
].join('\n')

function toolRowsFromMessages(messages: ChatMessage[]): UiToolRow[] {
  return messagesToUiItems(messages)
    .filter((item): item is Extract<typeof item, { kind: 'tool' }> => item.kind === 'tool')
    .map((item) => item.tool)
}

describe('e2e screenshot audit fixes (T1/T2/R1)', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-e2e-audit-'))
    toolTodoWrite(workspace, [{ id: '1', content: 'Apply the audited workspace edit', status: 'in_progress' }])
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('E1: executeTool humanizes malformed ask_question string (no Zod leak)', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({ questions: T1_MALFORMED_QUESTIONS }),
      workspace,
      new AbortController().signal,
      { runId: 'e2e-ask-bad', toolCallId: 'tc-ask-bad' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).not.toMatch(/Expected array, received string/)
    expect(result.content).toMatch(/JSON array/i)

    let msgs: ChatMessage[] = [{ role: 'user', content: 'fix empty screen' }]
    msgs = appendAssistantWithTools(msgs, '', [
      {
        id: 'tc-ask-bad',
        name: 'ask_question',
        arguments: JSON.stringify({ questions: T1_MALFORMED_QUESTIONS })
      }
    ])
    msgs = appendToolResult(msgs, 'tc-ask-bad', 'ask_question', result.content, false)

    const tools = toolRowsFromMessages(msgs)
    const ask = tools.find((t) => t.id === 'tc-ask-bad')
    expect(ask).toBeTruthy()
    const status = parseStatusMessageData(ask!)
    expect(status.chip).toBe('Invalid arguments')
    expect(status.message).not.toMatch(/Expected array, received string/)

    const group = mapToolGroupProps(tools, { groupTiming: { startedAt: 1_000 } })
    const nested = group.nestedTools.find((r) => r.name === 'ask_question')
    // Args do not yield a recoverable title; executeTool summary "Invalid arguments" is live-path only.
    expect(nested?.subtitle).toBe('')
    expect(nested?.title).not.toContain('…')

    expect(getToolHeaderMeta(ask!).target).not.toBe('Failed')
    expect(getToolHeaderMeta(ask!).target).not.toBe('Question')
    expect(result.summary).toBe('Invalid arguments')
  })

  it('E1: executeTool coerces parseable stringified questions array', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({
        title: 'Ready check',
        questions: JSON.stringify([{ id: 'q1', prompt: 'Ready?', type: 'boolean' }])
      }),
      workspace,
      new AbortController().signal,
      {
        runId: 'e2e-ask-ok',
        toolCallId: 'tc-ask-ok',
        askQuestion: async () => [{ questionId: 'q1', values: ['Yes'] }]
      }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('Ready check')
    expect(result.content).toMatch(/Yes/)
  })

  it('E2: timeout + Interrupted map to status chips through transcript', async () => {
    let msgs: ChatMessage[] = [{ role: 'user', content: 'q' }]
    msgs = appendAssistantWithTools(msgs, '', [
      {
        id: 'tc-timeout',
        name: 'ask_question',
        arguments: JSON.stringify({
          title: 'Diagnosing your empty screen',
          questions: [{ id: 'how_open', prompt: 'How open?', type: 'text' }]
        })
      },
      {
        id: 'tc-interrupted',
        name: 'ask_question',
        arguments: JSON.stringify({
          title: 'Other',
          questions: [{ id: 'x', prompt: 'X?', type: 'boolean' }]
        })
      }
    ])
    msgs = appendToolResult(msgs, 'tc-timeout', 'ask_question', T1_TIMEOUT_CONTENT, true)
    msgs = appendToolResult(msgs, 'tc-interrupted', 'ask_question', 'Interrupted', false)

    const tools = toolRowsFromMessages(msgs)
    expect(parseStatusMessageData(tools.find((t) => t.id === 'tc-timeout')!).chip).toBe(
      'Timed out'
    )
    expect(parseStatusMessageData(tools.find((t) => t.id === 'tc-interrupted')!).chip).toBe(
      'Interrupted'
    )
    expect(
      getToolHeaderMeta(tools.find((t) => t.id === 'tc-timeout')!).target
    ).toBe('Diagnosing your empty screen')
  })

  it('E2: executeTool empty answers yields T1 timeout content', async () => {
    const result = await executeTool(
      'ask_question',
      JSON.stringify({
        title: 'Diagnosing your empty screen',
        questions: [{ id: 'how_open', prompt: 'How?', type: 'text' }]
      }),
      workspace,
      new AbortController().signal,
      {
        runId: 'e2e-ask-timeout',
        toolCallId: 'tc-to',
        askQuestion: async () => []
      }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toBe(T1_TIMEOUT_CONTENT)
  })

  it('E3: executeTool unknown write_file_check — friendly content; UI not titled placeholder', async () => {
    const result = await executeTool(
      'write_file_check',
      JSON.stringify({ path: 'placeholder' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Unknown tool "write_file_check"/)
    expect(result.content).toMatch(/edit or str_replace/)

    let msgs: ChatMessage[] = [{ role: 'user', content: 'cleanup' }]
    msgs = appendAssistantWithTools(msgs, '', [
      { id: 'd1', name: 'delete', arguments: JSON.stringify({ path: '.sv.js' }) },
      {
        id: 'w1',
        name: 'write_file_check',
        arguments: JSON.stringify({ path: 'placeholder' })
      }
    ])
    msgs = appendToolResult(msgs, 'd1', 'delete', 'Deleted .sv.js', true)
    msgs = appendToolResult(msgs, 'w1', 'write_file_check', result.content, false)

    const tools = toolRowsFromMessages(msgs)
    const group = mapToolGroupProps(tools, { groupTiming: { startedAt: 1_000 } })
    const unknown = group.nestedTools.find((r) => r.name === 'write_file_check')
    expect(unknown?.title.toLowerCase()).not.toBe('placeholder')
    expect(unknown?.title.toLowerCase()).toMatch(/write/)
    expect(unknown?.subtitle).toBe('')
    expect(getToolHeaderMeta(tools.find((t) => t.id === 'w1')!).target).toBe('')
  })

  it('E4: R1 long-run tip predicate suppressed (auto + menu compact own continuity)', () => {
    // Formerly true at step 49 / billed 2_313_786; user /clear tips removed.
    expect(
      shouldShowTaskBoundaryTip({
        steps: 49,
        billedInputTokens: 2_313_786
      })
    ).toBe(false)
    expect(
      shouldShowTaskBoundaryTip({
        steps: 3,
        billedInputTokens: 120_000
      })
    ).toBe(false)
  })

  it('E5: executeTool edit applies bare @@ hunk (T1 index.html)', async () => {
    writeFileSync(join(workspace, 'index.html'), T1_INDEX_HTML, 'utf8')
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'index.html', diff: T1_BARE_DIFF }),
      workspace,
      new AbortController().signal,
      { runDir: workspace, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(result.content).not.toMatch(/No unified-diff hunks found/)
    const next = readFileSync(join(workspace, 'index.html'), 'utf8')
    expect(next).toContain('js/setup.js')
    expect(next).toContain('js/entities.js')
    expect(next).toContain('js/flow.js')

    // UI preview must accept the same bare @@ shape (no literal "@@" context row).
    const preview = parseUnifiedDiff(T1_BARE_DIFF)
    expect(preview.some((line) => line.text === '@@')).toBe(false)
    expect(preview.some((line) => line.kind === 'add')).toBe(true)
    expect(preview.some((line) => line.kind === 'del')).toBe(true)
  })

  it('D1: failed edit keeps path summary and surfaces error through UI adapters', async () => {
    const failContent = 'No unified-diff hunks found (need @@ headers)'
    const args = JSON.stringify({ path: 'index.html', diff: T1_BARE_DIFF })

    let msgs: ChatMessage[] = [{ role: 'user', content: 'fix scripts' }]
    msgs = appendAssistantWithTools(msgs, '', [
      { id: 'tc-edit-fail', name: 'edit', arguments: args }
    ])
    // Pre-fix T1 shape: summary was opaque "rejected"; path must win for UI.
    msgs = appendToolResult(msgs, 'tc-edit-fail', 'edit', failContent, false)

    const tools = toolRowsFromMessages(msgs)
    const edit = tools.find((t) => t.id === 'tc-edit-fail')
    expect(edit).toBeTruthy()
    expect(edit!.status).toBe('fail')

    expect(toolLabel('edit', 'fail', failContent)).toBe('Failed')
    expect(toolDefaultExpanded('edit', 'fail')).toBe(true)
    // Finished diffs stay compact — no full-patch dump into the timeline.
    expect(toolDefaultExpanded('edit', 'done')).toBe(false)
    expect(toolDefaultExpanded('git_diff', 'done')).toBe(false)

    const meta = getToolHeaderMeta(edit!)
    expect(meta.verb).toBe('Failed')
    expect(meta.target).toBe('index.html')
    // Header counts exist on the row meta, but ToolCard suppresses chips when failed.
    expect((meta.added ?? 0) + (meta.removed ?? 0)).toBeGreaterThan(0)

    const lines = parseDiffPreview(edit!)
    expect(lines.some((line) => line.text === '@@')).toBe(false)
    expect(lines.length).toBeGreaterThan(0)
    // EditBody shows tool.content error when status=fail (assert content preserved).
    expect(edit!.content).toBe(failContent)

    const group = mapToolGroupProps(tools, { groupTiming: { startedAt: 1_000 } })
    const nested = group.nestedTools.find((r) => r.name === 'edit')
    expect(nested?.subtitle?.toLowerCase()).not.toBe('rejected')
    expect(nested?.subtitle).toMatch(/index\.html/i)
  })

  it('D2: live edit argsPreview grows parseDiffPreview line-by-line (incomplete JSON)', () => {
    const completeArgs = JSON.stringify({
      path: 'index.html',
      diff: T1_BARE_DIFF
    })
    // Simulate tool_call_delta accumulation across incomplete JSON slices.
    const cuts = [20, 45, 80, 120, 180, 260, Math.floor(completeArgs.length * 0.85)]
      .filter((cut) => cut > 0 && cut < completeArgs.length)
    let prevLines = 0
    let sawAdd = false
    let sawDel = false

    for (const cut of cuts) {
      const preview = completeArgs.slice(0, cut)
      expect(() => JSON.parse(preview)).toThrow()
      const lines = parseDiffPreview({
        id: 'tc-live-edit',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: preview
      })
      expect(lines.length).toBeGreaterThanOrEqual(prevLines)
      prevLines = lines.length
      if (lines.some((l) => l.kind === 'add')) sawAdd = true
      if (lines.some((l) => l.kind === 'del')) sawDel = true
    }

    expect(prevLines).toBeGreaterThan(0)
    expect(sawAdd).toBe(true)
    expect(sawDel).toBe(true)

    // Final complete blob matches a normal done card parse.
    const finalLines = parseDiffPreview({
      id: 'tc-live-edit',
      name: 'edit',
      summary: 'index.html',
      status: 'running',
      argsPreview: completeArgs
    })
    expect(finalLines.length).toBeGreaterThanOrEqual(prevLines)
    expect(finalLines.some((l) => l.text === '@@')).toBe(false)

    // Path + counts available mid-stream once fields appear.
    const mid = completeArgs.slice(0, Math.floor(completeArgs.length * 0.7))
    expect(() => JSON.parse(mid)).toThrow()
    const midMeta = getToolHeaderMeta({
      id: 'tc-live-edit',
      name: 'edit',
      summary: '',
      status: 'running',
      argsPreview: mid
    })
    expect(midMeta.target).toBe('index.html')
    expect(midMeta.filePath).toBe('index.html')
    expect((midMeta.added ?? 0) + (midMeta.removed ?? 0)).toBeGreaterThan(0)

    // Compact default still holds while running — no full-patch dump.
    expect(toolDefaultExpanded('edit', 'running')).toBe(false)
  })

  it('D3: streaming contents write paints add lines before JSON closes', async () => {
    const full = JSON.stringify({
      path: 'notes.md',
      contents: '# Hello\n\nworld\nline3\n'
    })
    const mid = full.slice(0, full.length - 3) // strip closing quote + braces
    expect(() => JSON.parse(mid)).toThrow()

    const lines = parseDiffPreview({
      id: 'tc-write-live',
      name: 'edit',
      summary: '',
      status: 'running',
      argsPreview: mid
    })
    expect(lines.some((l) => l.kind === 'add' && l.text === '# Hello')).toBe(true)
    expect(lines.some((l) => l.kind === 'add' && l.text === 'world')).toBe(true)
    expect(lines.length).toBeGreaterThanOrEqual(3)

    // Apply still works once args complete (execute path unchanged).
    writeFileSync(join(workspace, 'notes.md'), '', 'utf8')
    const result = await executeTool(
      'edit',
      full,
      workspace,
      new AbortController().signal,
      { runDir: workspace, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toContain('# Hello')
  })

  it('D4: char-by-char argsPreview growth never shrinks painted diff lines', () => {
    const full = JSON.stringify({
      path: 'stream.ts',
      diff: ['@@', '-before', '+after one', '+after two'].join('\n')
    })
    let prev = 0
    let sawContent = false
    for (let i = 1; i <= full.length; i++) {
      const preview = full.slice(0, i)
      const lines = parseDiffPreview({
        id: 'tc-char',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: preview
      })
      expect(lines.length).toBeGreaterThanOrEqual(prev)
      prev = lines.length
      if (lines.some((l) => l.kind === 'add' || l.kind === 'del')) sawContent = true
    }
    expect(sawContent).toBe(true)
    expect(prev).toBeGreaterThanOrEqual(3)
  })

  it('E6: PowerShell spawns bash for/do/done instead of pre-failing (T1)', async () => {
    if (process.platform !== 'win32') {
      return
    }
    mkdirSync(join(workspace, 'js'), { recursive: true })
    writeFileSync(join(workspace, 'js', 'setup.js'), '1\n', 'utf8')
    const content = await toolTerminal(workspace, T1_BASH_FOR, new AbortController().signal, {
      shell: 'powershell'
    })
    expect(content).not.toMatch(/bash for-loop/i)

    const viaExecute = await executeTool(
      'terminal',
      JSON.stringify({ command: T1_BASH_FOR }),
      workspace,
      new AbortController().signal,
      { runDir: workspace, agentMode: 'agent', terminalShell: 'powershell' }
    )
    expect(viaExecute.content).not.toMatch(/bash for-loop/i)
  })
})
