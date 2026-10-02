/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { buildRecordModel, type BuildOptions, type WorkItem } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { WorkList, isBareIntent, outcomeLine, plainLine, plainProse, targetOf, thoughtLine } from '@renderer/features/task/record/WorkItems'
import { BriefText } from '@renderer/features/task/record/Brief'
import { TerminalBody } from '@renderer/features/chat/toolUi/bodies/TerminalBody'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

/**
 * What made the record hard to read (2026-10-01 audit of a long run): a
 * "Let me go." line between every two calls, asterisks in a History title, a
 * time on two lines, `[user]` as a pull's title, three rows saying one child
 * was cancelled, and three lines of `cwd / shell / status: done` over output.
 */

afterEach(cleanup)

const RUN_ID = '9695fdb2-8b5a-42fb-86df-2ea42ca4d341'
const SHORT_ID = '9695fdb2'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

function call(name: string, status: 'running' | 'done' | 'fail', content: string, args: Record<string, unknown> = {}, summary = ''): ToolItem {
  return {
    kind: 'tool',
    id: `${name}-1`,
    at: '2026-10-01T08:00:00.000Z',
    endedAt: '2026-10-01T08:15:00.000Z',
    tool: { id: `${name}-1`, name, summary, status, content, argsPreview: JSON.stringify(args) }
  }
}

function renderWork(work: WorkItem[], instances?: Record<string, AgentInstanceUiState>): HTMLElement {
  return render(
    <RunSessionProvider value={{ workspacePath: 'C:\\ws', runId: 'parent', agentInstances: instances }}>
      <WorkList items={work} />
    </RunSessionProvider>
  ).container
}

describe('a thought line', () => {
  it('skips a closing "Let me go." for the last paragraph that says something', () => {
    expect(thoughtLine('The log stopped growing at 252 bytes.\n\nLet me go.')).toBe('The log stopped growing at 252 bytes.')
    expect(thoughtLine('Both children are still running.\nOK.\nNow let me check.')).toBe('Both children are still running.')
  })

  it('keeps a next move that says what it is', () => {
    expect(thoughtLine('Let me read the config and then run the suite detached.')).toBe(
      'Let me read the config and then run the suite detached.'
    )
  })

  it('keeps the last line when nothing else is said', () => {
    expect(thoughtLine('Let me look.')).toBe('Let me look.')
  })

  it('never shows fenced code as the line', () => {
    expect(thoughtLine('The schema wants a flat list:\n```\nargs: string[]\n```')).toBe('The schema wants a flat list:')
  })

  it('in a long last paragraph, takes its last sentence that says something', () => {
    const long =
      'The run started at 13:52 and wrote its log to disk. It has not printed a summary yet, which is expected for a run of this size. The log stopped at 252 bytes. Let me poll it.'
    expect(long.length).toBeGreaterThan(160)
    expect(thoughtLine(long)).toBe('The log stopped at 252 bytes.')
  })

  it('is told apart from a nod or a bare next move', () => {
    expect(isBareIntent('Let me go.')).toBe(true)
    expect(isBareIntent('Okay, let me batch reads.')).toBe(true)
    expect(isBareIntent('Good.')).toBe(true)
    expect(isBareIntent('Let me poll it. The log stopped at 252 bytes.')).toBe(false)
    expect(isBareIntent('Let me read the config and then run the suite.')).toBe(false)
    // A decision, however short, is a thought.
    expect(isBareIntent('So I will ask once.')).toBe(false)
  })

  it('is set upright and quiet, not in italics', () => {
    const message: Extract<UiItem, { kind: 'message' }> = { kind: 'message', id: 'm1', role: 'assistant', content: '', thinking: 'x' }
    renderWork([{ kind: 'thought', id: 't1', item: message, text: 'The config reads 8 forks.', streaming: false }])
    const line = screen.getByText('The config reads 8 forks.')
    expect(line.classList.contains('italic')).toBe(false)
    expect(line.classList.contains('text-tertiary')).toBe(true)
  })
})

describe('a title made from markdown', () => {
  it('drops emphasis, code ticks and link targets', () => {
    expect(plainLine('Checks recorded: **4 met, 3 not met.** Nothing is left')).toBe('Checks recorded: 4 met, 3 not met. Nothing is left')
    expect(plainLine('## Ran `pnpm test` — see [the log](https://x.y)')).toBe('Ran pnpm test — see the log')
    expect(plainLine('Fixed _both_ rows')).toBe('Fixed both rows')
  })

  it('leaves names and arithmetic alone', () => {
    expect(plainLine('spawn_detached rejected a * b')).toBe('spawn_detached rejected a * b')
  })

  it('keeps code spans when quoting prose as text, a citation made one', () => {
    expect(plainProse('**Fixed** `*args*` in [[src/a.ts:3]] — see [docs](https://x.y)')).toBe('Fixed `*args*` in `src/a.ts:3` — see docs')
  })

  it('heads a History run without the answer\'s asterisks, its time on one line', () => {
    const at = (s: number): string => new Date(Date.parse('2026-10-01T08:00:00Z') + s * 1000).toISOString()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Audit it', at: at(0) },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'Checks recorded: **4 met, 3 not met.**', at: at(4163) },
      { kind: 'message', id: 'user-2', role: 'user', content: 'Fix all', at: at(4200) },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'Done.', at: at(4300) }
    ]
    const options: BuildOptions = { running: false }
    const { container } = render(<TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} />)
    const row = container.querySelector('[data-history-run="1"]') as HTMLElement
    expect(row.textContent).toContain('Checks recorded: 4 met, 3 not met.')
    expect(row.textContent).not.toContain('**')
    const time = [...row.querySelectorAll('span')].find((s) => s.textContent === '1h 9m 23s')
    expect(time?.classList.contains('whitespace-nowrap')).toBe(true)
  })
})

describe('a call the labels do not know', () => {
  it('names what its summary adds, not its own name again', () => {
    expect(targetOf('spawn_detached', 'spawn_detached (agent-built)')).toBe('agent-built')
    expect(targetOf('spawn_detached', 'spawn_detached')).toBe('')
    expect(targetOf('delete', 'src/a.ts')).toBe('src/a.ts')
  })

  it('says it failed in a word as well as in red', () => {
    const item = call('spawn_detached', 'fail', 'logName and a non-empty args[] are required', {}, 'spawn_detached (agent-built)')
    const container = renderWork([{ kind: 'tool', id: 'w1', tool: item }])
    const row = container.querySelector('[data-record-tool="spawn_detached"]') as HTMLElement
    expect(row.textContent).toContain('Spawn Detached')
    expect(row.textContent).toContain('agent-built')
    expect(row.textContent).not.toContain('spawn_detached (agent-built)')
    expect(screen.getByText('failed')).toBeTruthy()
  })
})

describe('the parent waiting on a child', () => {
  const TIMED_OUT = `Timed out waiting for Agent V Instance id; ${RUN_ID} (short ${SHORT_ID}) after 900000 ms. Child is still running.`

  it('says an await ran out of time, not what the child did after', () => {
    const container = renderWork(
      [{ kind: 'instance', id: 'w1', tool: call('await_agent_instance', 'fail', TIMED_OUT, { run_id: RUN_ID }) }],
      { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'cancelled', summary: 'Instance cancelled.' } }
    )
    expect(screen.getByText(`Waited for instance ${SHORT_ID}`)).toBeTruthy()
    expect(screen.getByText('Timed out after 15m, still running then')).toBeTruthy()
    expect(screen.queryByText(`Instance cancelled ${SHORT_ID}`)).toBeNull()
    expect(container.querySelector('.text-danger')).toBeNull()
  })

  it('titles a finished child\'s timed-out await with nothing of the timeout message', () => {
    const container = renderWork(
      [{ kind: 'instance', id: 'w1', tool: call('await_agent_instance', 'fail', TIMED_OUT, { run_id: RUN_ID }) }],
      { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'done', summary: 'Done.' } }
    )
    expect(screen.getByText(`Instance finished ${SHORT_ID}`)).toBeTruthy()
    expect(container.textContent).not.toContain('Timed out waiting for')
  })

  it('says a cancelled child once, muted', () => {
    const container = renderWork(
      [{ kind: 'instance', id: 'w1', tool: call('await_agent_instance', 'fail', `Agent V Instance id; ${RUN_ID}\nphase: cancelled`, { run_id: RUN_ID }) }],
      { [RUN_ID]: { instanceRunId: RUN_ID, phase: 'cancelled', summary: 'Instance cancelled.' } }
    )
    expect(screen.getByText(`Instance cancelled ${SHORT_ID}`)).toBeTruthy()
    expect(screen.queryByText('Instance cancelled.')).toBeNull()
    expect(container.querySelector('.text-danger')).toBeNull()
  })

  it('heads a pull with how the child stood, never its first role marker', () => {
    // As older builds wrote it: the header facts run together on one line.
    const legacy = `Agent V Instance id; ${RUN_ID} (short ${SHORT_ID})status: runningshowing 36 of 36 messages\n\n[user]\nOutcome: the suite exits 0.\n\n[assistant]\nReading the config.`
    const container = renderWork([{ kind: 'instance', id: 'w1', tool: call('pull_agent_instance', 'done', legacy, { run_id: RUN_ID }) }], {
      [RUN_ID]: { instanceRunId: RUN_ID, phase: 'started' }
    })
    const row = container.querySelector('[data-record-tool="pull_agent_instance"]') as HTMLElement
    expect(row.textContent).toContain('running · 36 messages')
    expect(row.textContent).not.toContain('[user]')
  })

  it('reads the same from a pull with one header fact per line', () => {
    const current = `Agent V Instance id; ${RUN_ID} (short ${SHORT_ID})\nstatus: done\nshowing 2 of 2 messages\n\n[user]\ngo\n\n[assistant]\ndone`
    const container = renderWork([{ kind: 'instance', id: 'w1', tool: call('pull_agent_instance', 'done', current, { run_id: RUN_ID }) }], {
      [RUN_ID]: { instanceRunId: RUN_ID, phase: 'done' }
    })
    const row = container.querySelector('[data-record-tool="pull_agent_instance"]') as HTMLElement
    expect(row.textContent).toContain('done · 2 messages')
    fireEvent.click(row.querySelector('button') as HTMLElement)
    expect(row.textContent).not.toContain('showing 2 of 2')
  })
})

describe('what a child was asked for', () => {
  it('is its outcome, label dropped, wherever the brief names one', () => {
    expect(outcomeLine('Outcome: The suite exits 0.\n\nSub-tasks: …')).toBe('The suite exits 0.')
    expect(outcomeLine('Vyotiq is an Electron agent.\n\n## Outcome\n\n`pnpm test` exits 0')).toBe('`pnpm test` exits 0')
    expect(outcomeLine('Vyotiq is an Electron agent.')).toBe('')
  })

  it('reads from the child when the cut args preview lost it, never the goal\'s opener', () => {
    // The preview is cut inside the long goal, before `outcome`.
    const preview = '{"goal": "Vyotiq is an Electron coding agent. Its `git_apply` tool accepts a unified diff'
    const spawn: ToolItem = {
      kind: 'tool',
      id: 's1',
      tool: { id: 's1', name: 'spawn_agent_instance', summary: '', status: 'done', content: `Agent V Instance id; ${RUN_ID} (short ${SHORT_ID})\nrun_id: ${RUN_ID}`, argsPreview: preview }
    }
    const container = renderWork([{ kind: 'instance', id: 'w1', tool: spawn }], {
      [RUN_ID]: { instanceRunId: RUN_ID, phase: 'done', goal: 'Outcome: `patchTouchedPaths` reads only real headers.\n\nSub-t' }
    })
    expect(container.textContent).toContain('patchTouchedPaths reads only real headers.')
    expect(container.textContent).not.toContain('Vyotiq is an Electron')
  })
})

describe('notes the loop wrote for the model', () => {
  it('never show in a call\'s output, and a call left with nothing more to say does not open', () => {
    const del = call('delete', 'done', 'Deleted tests/a.test.ts\n\n[Soft warning: this step mutated file(s) without calling diagnostics. Run diagnostics (typecheck/lint) before treating the change as done.]', { path: 'tests/a.test.ts' }, 'tests/a.test.ts')
    const container = renderWork([{ kind: 'tool', id: 'w1', tool: del }])
    const row = container.querySelector('[data-record-tool="delete"]') as HTMLElement
    expect(row.querySelector('button[aria-expanded]')).toBeNull()
    expect(row.textContent).not.toContain('Soft warning')
  })
})

describe('a single lookup', () => {
  it('names what it read rather than counting it', () => {
    const item = call('read', 'done', 'const a = 1', { path: 'vitest.config.ts' }, 'vitest.config.ts')
    const container = renderWork([{ kind: 'explore', id: 'w1', tools: [item] }])
    expect(container.textContent).toContain('vitest.config.ts')
    expect(container.textContent).not.toContain('1 file')
  })
})

describe('command output', () => {
  const tool = {
    id: 't',
    name: 'terminal',
    summary: '',
    status: 'done' as const,
    argsPreview: JSON.stringify({ command: 'pnpm test' }),
    content: 'session_id: s1\nstatus: done\ncommand: pnpm test\ncwd: C:\\ws\nshell: powershell\nall passed\n\nexit_code: 0'
  }

  it('starts with the output when it ran in the workspace itself', () => {
    render(
      <RunSessionProvider value={{ workspacePath: 'C:\\ws', runId: 'r' }}>
        <TerminalBody tool={tool} />
      </RunSessionProvider>
    )
    const out = screen.getByTestId('terminal-viewport').textContent ?? ''
    expect(out).toContain('all passed')
    expect(out).not.toMatch(/cwd:|shell:|status: done|---/)
  })

  it('starts on the first line of output, not the blank lines a shell printed first', () => {
    render(
      <RunSessionProvider value={{ workspacePath: 'C:\\ws', runId: 'r' }}>
        <TerminalBody tool={{ ...tool, content: 'cwd: C:\\ws\nshell: powershell\n\r\n\n  indented first\n\nexit_code: 0' }} />
      </RunSessionProvider>
    )
    expect(screen.getByTestId('terminal-viewport').textContent).toBe('  indented first')
  })

  it('says where it ran when that was somewhere else', () => {
    render(
      <RunSessionProvider value={{ workspacePath: 'C:\\other', runId: 'r' }}>
        <TerminalBody tool={tool} />
      </RunSessionProvider>
    )
    const out = screen.getByTestId('terminal-viewport').textContent ?? ''
    expect(out).toContain('cwd: C:\\ws')
    expect(out).toContain('shell: powershell')
    expect(out).not.toContain('status: done')
  })
})

describe('a brief', () => {
  it('reads a backticked span as code, the rest as written', () => {
    const { container } = render(<BriefText text={'The check "`pnpm exec vitest run` exits 0" is not met. **as typed**'} />)
    const code = container.querySelector('[data-ticked-code]')
    expect(code?.textContent).toBe('pnpm exec vitest run')
    expect(container.textContent).toBe('The check "pnpm exec vitest run exits 0" is not met. **as typed**')
  })
})
