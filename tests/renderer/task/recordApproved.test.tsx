/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { PersistedEvent, ToolApprovalGrant } from '@shared/ipc'
import { applyEventTimestamps, type UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { approvedByText } from '@renderer/features/task/record/WorkItems'

/**
 * Once a held call is answered, the record says who let it run and for how
 * long — from the decision main saved on the call's result, so it survives a
 * reload.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-09-30T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const user = (text: string): UiItem => ({ kind: 'message', id: 'user-0', role: 'user', content: text, at: at(0) })
const said = (text: string): UiItem => ({ kind: 'message', id: 'a-1', role: 'assistant', content: text, at: at(9) })
function call(id: string, name: string, args: Record<string, unknown>, content: string, approvedBy?: ToolApprovalGrant): UiItem {
  return {
    kind: 'tool',
    id,
    at: at(1),
    endedAt: at(2),
    tool: { id, name, summary: '', status: 'done', content, argsPreview: JSON.stringify(args), ...(approvedBy ? { approvedBy } : {}) }
  }
}

function show(items: UiItem[], options: BuildOptions = { running: false }) {
  const model = buildRecordModel(items, options)
  return render(<TaskRecord model={model} options={options} messageCount={items.length} />)
}

describe('approvedByText', () => {
  it('says who allowed it and for how long, for each decision that exists', () => {
    const text = (g: ToolApprovalGrant): string => {
      const t = approvedByText(g)
      return `${t.lead}${t.allow ?? ''}${t.tail ?? ''}`
    }
    expect(text({ by: 'you', scope: 'once' })).toBe('Allowed by you')
    expect(text({ by: 'you', scope: 'task' })).toBe('Allowed by you · always for this task')
    expect(text({ by: 'you', scope: 'workspace', allow: 'pnpm vitest' })).toBe(
      'Allowed by you · always for pnpm vitest in this workspace'
    )
    expect(text({ by: 'rule', scope: 'task' })).toBe('Allowed by a rule for this task')
    expect(text({ by: 'rule', scope: 'workspace' })).toBe('Allowed by a rule for this workspace')
  })
})

describe('the decision on a command card', () => {
  it('sits above the card, muted, with the remembered command in mono', () => {
    const { container } = show([
      user('Migrate'),
      call('t1', 'terminal', { command: 'pnpm db:migrate' }, 'exit_code: 0', {
        by: 'you',
        scope: 'workspace',
        allow: 'pnpm db:migrate'
      }),
      said('Done.')
    ])
    const line = container.querySelector('[data-record-approved]') as HTMLElement
    expect(line.getAttribute('data-record-approved')).toBe('you:workspace')
    expect(line.textContent).toBe('Allowed by you · always for pnpm db:migrate in this workspace')
    expect(line.className).toContain('text-tertiary')
    expect(line.querySelector('.font-mono')?.textContent).toBe('pnpm db:migrate')
    // Above the command it let through, not inside it.
    const card = container.querySelector('[data-record-command]') as HTMLElement
    expect(line.nextElementSibling).toBe(card)
  })

  it('says a rule once per run, on the first call it let through; your own answers every time', () => {
    const rule: ToolApprovalGrant = { by: 'rule', scope: 'workspace' }
    const { container } = show([
      user('Edit two files and test'),
      call('e1', 'edit', { path: 'a.ts', diff: '@@\n-a\n+b\n' }, 'Applied diff to a.ts', rule),
      call('t1', 'terminal', { command: 'pnpm test' }, 'exit_code: 0', { by: 'you', scope: 'once' }),
      // Three calls: from four, a settled run's loose work folds to one line.
      call('e2', 'edit', { path: 'b.ts', diff: '@@\n-a\n+b\n' }, 'Applied diff to b.ts', rule),
      said('Done.')
    ])
    const lines = [...container.querySelectorAll('[data-record-approved]')].map((l) => l.getAttribute('data-record-approved'))
    expect(lines).toEqual(['rule:workspace', 'you:once'])
  })

  it('says nothing for a call the gate never held', () => {
    const { container } = show([user('Look'), call('t1', 'terminal', { command: 'ls' }, 'exit_code: 0'), said('Done.')])
    expect(container.querySelector('[data-record-approved]')).toBeNull()
  })
})

describe('after a reload', () => {
  it('reads the decision back from the call’s saved result', () => {
    const items = [call('t1', 'delete', { path: 'a.ts' }, 'Deleted a.ts')]
    const events: PersistedEvent[] = [
      { at: at(1), event: { type: 'tool_start', runId: 'r', toolCallId: 't1', name: 'delete', summary: 'a.ts' } },
      {
        at: at(2),
        event: {
          type: 'tool_result',
          runId: 'r',
          toolCallId: 't1',
          name: 'delete',
          summary: 'a.ts',
          ok: true,
          approvedBy: { by: 'you', scope: 'task' }
        }
      }
    ]
    const [row] = applyEventTimestamps(items, events)
    expect(row?.kind === 'tool' ? row.tool.approvedBy : null).toEqual({ by: 'you', scope: 'task' })
  })
})
