/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { collectTaskCommands } from '@renderer/features/inspector/taskCommands'
import { TaskCommandList } from '@renderer/features/inspector/TaskCommandList'

afterEach(() => cleanup())

type ToolItem = Extract<UiItem, { kind: 'tool' }>

const call = (
  id: string,
  command: string,
  status: ToolItem['tool']['status'],
  content?: string,
  extra: Partial<ToolItem> = {}
): ToolItem => ({
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
  },
  ...extra
}) as ToolItem

describe('collectTaskCommands', () => {
  it('reads each terminal call the way its card in the record does', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u', role: 'user', content: 'go', at: 1 } as UiItem,
      call('ok', 'pnpm test', 'done', 'cwd: /ws\n1 passed\nexit_code: 0'),
      call('bad', 'pnpm lint', 'done', 'cwd: /ws\nstderr:\nsrc/a.ts: 2 problems\nexit_code: 1'),
      call('stop', 'pnpm build', 'fail', 'Interrupted'),
      call('no', 'rm -rf out', 'fail', 'The user denied permission to run terminal'),
      call('live', 'pnpm dev', 'running'),
      call('ask', 'git push', 'running', undefined, { approval: { id: 'a1' } } as Partial<ToolItem>),
      {
        kind: 'tool',
        id: 'edit',
        at: 3,
        tool: { toolCallId: 'edit', name: 'edit', status: 'done', summary: 'a.ts' }
      } as UiItem
    ]
    const commands = collectTaskCommands(items)
    expect(commands.map((c) => [c.command, c.state])).toEqual([
      ['pnpm test', 'done'],
      ['pnpm lint', 'failed'],
      ['pnpm build', 'stopped'],
      ['rm -rf out', 'refused'],
      ['pnpm dev', 'running'],
      ['git push', 'waiting']
    ])
    expect(commands[0]).toMatchObject({ exitCode: 0, durationMs: 4000, tail: ['1 passed'] })
    expect(commands[1]).toMatchObject({ exitCode: 1, tail: ['src/a.ts: 2 problems'] })
    expect(commands[3]).toMatchObject({ refusal: 'Denied', tail: [] })
    expect(commands[4]!.durationMs).toBeNull()
  })

  it('keeps only the last lines a command printed', () => {
    const printed = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    const [command] = collectTaskCommands([call('long', 'seq 20', 'done', `cwd: /ws\n${printed}\nexit_code: 0`)])
    expect(command!.tail).toEqual(['line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'line 20'])
  })
})

describe('TaskCommandList', () => {
  it('lists each command with where it stands, its exit code and time', () => {
    render(
      <TaskCommandList
        commands={collectTaskCommands([
          call('ok', 'pnpm test', 'done', 'cwd: /ws\n1 passed\nexit_code: 0'),
          call('bad', 'pnpm lint', 'done', 'cwd: /ws\nproblems\nexit_code: 1'),
          call('stop', 'pnpm build', 'fail', 'Interrupted'),
          call('live', 'pnpm dev', 'running')
        ])}
      />
    )
    const list = screen.getByRole('list', { name: 'What this task ran' })
    expect(list.textContent).toContain('pnpm test')
    expect(screen.getByText('exit 0 · 4s')).toBeTruthy()
    // A failure says so in words, not only in red.
    const failed = screen.getByText('exit 1 · 4s')
    expect(failed.className).toContain('text-danger')
    expect(screen.getByText('stopped')).toBeTruthy()
    expect(screen.getByText('running')).toBeTruthy()
    expect(screen.getByText('1 passed')).toBeTruthy()
  })

  it('says nothing has run yet', () => {
    render(<TaskCommandList commands={[]} />)
    expect(screen.getByText('Nothing run yet')).toBeTruthy()
  })
})
