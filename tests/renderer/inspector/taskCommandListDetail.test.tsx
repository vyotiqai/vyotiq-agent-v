/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { collectTaskCommands, commandsRanIn } from '@renderer/features/inspector/taskCommands'
import { TaskCommandList } from '@renderer/features/inspector/TaskCommandList'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

type ToolItem = Extract<UiItem, { kind: 'tool' }>

const call = (id: string, command: string, status: ToolItem['tool']['status'], content?: string): ToolItem =>
  ({
    kind: 'tool',
    id,
    at: '2026-09-30T10:00:00.000Z',
    endedAt: status === 'running' ? undefined : '2026-09-30T10:00:04.000Z',
    tool: {
      toolCallId: id,
      name: 'terminal',
      status,
      summary: command,
      argsPreview: JSON.stringify({ command }),
      ...(content !== undefined ? { content } : {})
    }
  }) as unknown as ToolItem

const printed = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('earlier lines', () => {
  it('counts the lines left out above the tail', () => {
    const [long, short] = collectTaskCommands([
      call('long', 'seq 20', 'done', `cwd: /ws\n${printed(20)}\nexit_code: 0`),
      call('short', 'seq 3', 'done', `cwd: /ws\n${printed(3)}\nexit_code: 0`)
    ])
    expect(long).toMatchObject({ earlier: 14, tail: ['line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20'] })
    expect(short!.earlier).toBe(0)
  })

  it('says how many came before, above that output only', () => {
    const { container } = render(
      <TaskCommandList
        commands={collectTaskCommands([
          call('long', 'seq 20', 'done', `cwd: /ws\n${printed(20)}\nexit_code: 0`),
          call('one', 'seq 7', 'done', `cwd: /ws\n${printed(7)}\nexit_code: 0`),
          call('short', 'seq 3', 'done', `cwd: /ws\n${printed(3)}\nexit_code: 0`)
        ])}
      />
    )
    const notes = [...container.querySelectorAll('[data-task-command-earlier]')]
    expect(notes.map((n) => n.textContent)).toEqual(['14 earlier lines', '1 earlier line'])
    // Above the output it stands for, muted.
    expect(notes[0]!.nextElementSibling?.textContent).toBe('line 15')
    expect(notes[0]!.className).toContain('text-tertiary')
  })
})

describe('where the commands ran', () => {
  it('names the workspace folder', () => {
    const commands = collectTaskCommands([call('ok', 'pnpm test', 'done', 'cwd: /home/me/code/shop\nok\nexit_code: 0')])
    render(<TaskCommandList commands={commands} workspacePath="/home/me/code/shop" />)
    const where = document.querySelector('[data-task-commands-where]')!
    expect(where.textContent).toBe('shop · what this task ran')
    expect(where.getAttribute('title')).toBe('/home/me/code/shop')
  })

  it('names the worktree when the commands ran outside the workspace', () => {
    const commands = collectTaskCommands([
      call('ok', 'pnpm test', 'done', 'cwd: /home/me/.vyotiq/task-worktrees/shop/fix-swap\nok\nexit_code: 0')
    ])
    expect(commandsRanIn(commands, '/home/me/code/shop')).toEqual({
      name: 'fix-swap',
      path: '/home/me/.vyotiq/task-worktrees/shop/fix-swap'
    })
  })

  it('keeps the workspace for a command run in a folder inside it', () => {
    const commands = collectTaskCommands([call('ok', 'ls', 'done', 'cwd: /home/me/code/shop/src\nok\nexit_code: 0')])
    expect(commandsRanIn(commands, '/home/me/code/shop')?.name).toBe('shop')
  })

  it('falls back to a plain header when nothing names a folder', () => {
    render(<TaskCommandList commands={collectTaskCommands([call('live', 'pnpm dev', 'running')])} />)
    expect(document.querySelector('[data-task-commands-where]')?.textContent).toBe('What this task ran')
  })
})

describe('a running command', () => {
  it('reads as the record does: a live word, and its time counting up', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-30T10:00:12.000Z'))
    render(<TaskCommandList commands={collectTaskCommands([call('live', 'pnpm dev', 'running')])} />)
    expect(screen.getByText('running').className).toContain('vy-text-live')
    const elapsed = document.querySelector('[data-task-command-elapsed]')!
    expect(elapsed.textContent).toBe('12s')
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(elapsed.textContent).toBe('15s')
  })

  it('shows no time once it has finished counting', () => {
    render(
      <TaskCommandList commands={collectTaskCommands([call('ok', 'pnpm test', 'done', 'cwd: /ws\nok\nexit_code: 0')])} />
    )
    expect(document.querySelector('[data-task-command-elapsed]')).toBeNull()
  })
})
