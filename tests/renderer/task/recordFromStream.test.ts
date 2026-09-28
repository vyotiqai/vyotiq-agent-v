/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { buildRecordModel, type RecordRun, type WorkItem } from '@renderer/features/task/recordModel'

/** The GUI e2e fixture: a plan, work in and between its steps, words after a call. */
const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'gui-e2e', 'fixtures', 'record-order.json'), 'utf8')
) as { events: Array<Omit<AgentEvent, 'runId'>> }

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function stream(upTo = fixture.events.length) {
  const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
  controller.hydrateTranscript([{ role: 'user', content: 'Check the config and the tests', at: '2026-09-27T10:00:00.000Z' }])
  for (const event of fixture.events.slice(0, upTo)) {
    controller.handleEvent({ ...event, runId: 'r1', invokeId: 1 } as AgentEvent)
  }
  return controller
}

const paths = (w: WorkItem | undefined): string[] =>
  w?.kind === 'explore' ? w.tools.map((t) => (JSON.parse(t.tool.argsPreview ?? '{}') as { path: string }).path) : []

function shape(run: RecordRun) {
  return {
    steps: run.steps.map((s) => ({ title: s.title, work: s.work.map((w) => (w.kind === 'note' ? `note:${w.text}` : `${w.kind}:${paths(w).join(',')}`)), between: s.between.flatMap(paths) })),
    setup: run.setup.map((w) => w.kind),
    after: run.after.map((w) => w.kind),
    result: run.result?.text ?? null
  }
}

describe('a streamed run becomes a record in order', () => {
  it('while live: each step’s words head its own calls, and work between steps sits between them', async () => {
    const lastLiveEvent = fixture.events.findIndex((e) => e.type === 'text_delta' && 'text' in e && String(e.text).includes('RECORD_ORDER_DONE'))
    const controller = stream(lastLiveEvent)
    await settle()
    const [run] = buildRecordModel(controller.items, { running: true }).runs
    expect(shape(run!)).toEqual({
      steps: [
        { title: 'Read the config', work: ['note:STEP_ONE_WORDS reading the config.', 'explore:config.json'], between: ['between-steps.md'] },
        { title: 'Read the tests', work: ['explore:app.test.ts'], between: [] }
      ],
      setup: ['note'],
      after: [],
      result: null
    })
  })

  it('once over: every step keeps its work, and the answer is the result', async () => {
    const controller = stream()
    await settle()
    expect(controller.running).toBe(false)
    const [run] = buildRecordModel(controller.items, { running: false }).runs
    expect(shape(run!)).toEqual({
      steps: [
        { title: 'Read the config', work: ['note:STEP_ONE_WORDS reading the config.', 'explore:config.json'], between: ['between-steps.md'] },
        { title: 'Read the tests', work: ['explore:app.test.ts'], between: [] }
      ],
      setup: ['note'],
      after: [],
      result: 'Both read. RECORD_ORDER_DONE.'
    })
    expect(run!.steps.map((s) => s.state)).toEqual(['done', 'done'])
  })
})
