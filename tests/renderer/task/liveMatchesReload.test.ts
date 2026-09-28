/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatMessage } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { buildRecordModel, type WorkItem } from '@renderer/features/task/recordModel'

/**
 * Each case is a run that drew differently while it streamed than after a
 * reload, found by replaying real sessions from disk both ways (2026-09-28).
 */

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 40))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function controllerWith(messages: ChatMessage[]) {
  const c = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
  c.hydrateTranscript(messages)
  const send = async (event: object): Promise<void> => {
    c.handleEvent({ runId: 'r1', ...event } as AgentEvent)
    await settle()
  }
  return { c, send }
}

const kinds = (list: readonly WorkItem[]): string[] => list.map((w) => w.kind)

describe('a streamed run draws as it will after a reload', () => {
  it('draws a file the model wrote under an alias as an edit card, not a one-line call', async () => {
    const { c, send } = controllerWith([{ role: 'user', content: 'Write it', at: '2026-09-28T10:00:00.000Z' }])
    await send({ type: 'status', status: 'running', invokeId: 1 })
    // Older logs, and hosts main cannot rename for: the call streams as `write`.
    await send({ type: 'tool_call_delta', toolCallId: 'c1', name: 'write', argumentsDelta: '{"path":"a/grid.mjs","content":"x"}' })
    await send({
      type: 'assistant_message',
      content: 'Writing the grid.',
      toolCalls: [{ id: 'c1', name: 'edit', arguments: '{"path":"a/grid.mjs","content":"x"}' }]
    })
    await send({ type: 'tool_start', toolCallId: 'c1', name: 'edit', summary: 'a/grid.mjs' })
    await send({ type: 'tool_result', toolCallId: 'c1', name: 'edit', summary: 'a/grid.mjs', ok: true, content: 'Created a/grid.mjs (1 chars)' })

    const row = c.items.find((i): i is Extract<UiItem, { kind: 'tool' }> => i.kind === 'tool')!
    expect(row.tool.name).toBe('edit')
    expect(row.tool.presentation).toBe('prominent')
    const [run] = buildRecordModel(c.items, { running: true }).runs
    expect(kinds(run!.after)).toEqual(['note', 'card'])
  })

  it('drops the reasoning of an empty response main discards before it retries', async () => {
    const { c, send } = controllerWith([{ role: 'user', content: 'Finish', at: '2026-09-28T10:00:00.000Z' }])
    await send({ type: 'status', status: 'running', invokeId: 1 })
    await send({ type: 'thinking_delta', text: 'All work is complete.' })
    await send({ type: 'thinking_done', text: 'All work is complete.' })
    await send({ type: 'assistant_message', content: '', thinking: 'All work is complete.' })
    await send({ type: 'incomplete', invokeId: 1, reason: 'empty_response', message: 'Model returned an empty response; retrying…' })
    // The retry: its own reasoning, then the answer.
    await send({ type: 'thinking_delta', text: 'All six tasks are complete.' })
    await send({ type: 'thinking_done', text: 'All six tasks are complete.' })
    await send({ type: 'text_delta', text: 'Done.' })
    await send({ type: 'assistant_message', content: 'Done.', thinking: 'All six tasks are complete.' })

    const [run] = buildRecordModel(c.items, { running: true, showThinking: true }).runs
    const thoughts = run!.after.filter((w) => w.kind === 'thought').map((w) => (w.kind === 'thought' ? w.text : ''))
    expect(thoughts).toEqual(['All six tasks are complete.'])
  })

  it('shows a /compact run after a watched run ended, verifying then failed', async () => {
    const { c, send } = controllerWith([{ role: 'user', content: 'Go', at: '2026-09-28T10:00:00.000Z' }])
    await send({ type: 'status', status: 'running', invokeId: 1 })
    await send({ type: 'text_delta', text: 'All done.' })
    await send({ type: 'assistant_message', content: 'All done.' })
    await send({ type: 'status', status: 'done', invokeId: 1 })

    await send({ type: 'compaction_started', mode: 'manual' })
    await send({ type: 'compaction_verifying', summary: '## Session Intent - ship it' })
    const card = () => c.items.find((i): i is Extract<UiItem, { kind: 'compaction' }> => i.kind === 'compaction')
    expect(card()?.verifyStatus).toBe('verifying')
    await send({ type: 'compaction_verify_failed', summary: '## Session Intent - ship it', failures: ['missed a file'] })
    expect(card()?.verifyStatus).toBe('failed')
    expect(c.items.filter((i) => i.kind === 'compaction')).toHaveLength(1)

    // And the answer is still the run's result, with the fold after it.
    const [run] = buildRecordModel(c.items, { running: false }).runs
    expect(run!.result?.text).toBe('All done.')
    expect(kinds(run!.after)).toEqual(['compaction'])
  })
})

describe('a model that never marks a step in progress', () => {
  const T0 = Date.parse('2026-09-28T10:00:00.000Z')
  const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
  let n = 0
  const tool = (name: string, args: Record<string, unknown>, content: string, s: number): UiItem => ({
    kind: 'tool',
    id: `t${++n}`,
    at: at(s),
    endedAt: at(s),
    tool: { id: `c${n}`, name, summary: String(args.path ?? ''), status: 'done', content, argsPreview: JSON.stringify(args) }
  })
  const todos = (marks: Array<' ' | 'x'>, s: number): UiItem =>
    tool(
      'todo_write',
      {},
      [`${marks.filter((m) => m === 'x').length}/${marks.length} complete`, ...marks.map((m, i) => `[${m}] (s${i + 1}) Step ${i + 1}`)].join('\n'),
      s
    )
  const edit = (path: string, s: number): UiItem =>
    tool('str_replace', { path, old_string: 'a', new_string: 'b' }, `Replaced in ${path}`, s)

  it('puts the work after a step it ticked off after that step, not above every step', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Go', at: at(0) },
      todos([' ', ' ', ' '], 1),
      edit('one.ts', 2),
      todos(['x', ' ', ' '], 3),
      // Nothing in progress now: this follows step 1.
      edit('two.ts', 4)
    ]
    const [run] = buildRecordModel(items, { running: true }).runs
    expect(run!.setup).toEqual([])
    const [s1] = run!.steps
    expect(kinds(s1!.work)).toEqual(['card'])
    expect(kinds(s1!.between)).toEqual(['card'])
  })

  it('follows the last of several steps ticked off at once', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Go', at: at(0) },
      todos([' ', ' ', ' '], 1),
      todos(['x', 'x', ' '], 2),
      edit('three.ts', 3)
    ]
    const [run] = buildRecordModel(items, { running: true }).runs
    expect(run!.setup).toEqual([])
    expect(kinds(run!.steps[1]!.between)).toEqual(['card'])
  })
})
