import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, ftruncateSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'vy-run-bundle-'))

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

import type { ChatMessage } from '@shared/ipc'
import { applyEventTimestamps, applyPersistedLiveTools, messagesToUiItems } from '@shared/transcript'
import {
  appendEvent,
  appendMessage,
  createRun,
  flushEventAppends,
  flushMessageAppends,
  listRuns,
  loadEventsForRunAsync,
  loadMessagesWindowAsync,
  loadStatus,
  updateStatus
} from '@main/agent/state'
import {
  RUN_BUNDLE_MAX_BYTES,
  RunBundleError,
  buildRunBundle,
  importRunBundle,
  isImportedRun,
  parseRunBundle,
  readRunBundleFile,
  serializeRunBundle
} from '@main/agent/runBundle'
import { resolveRunDir } from '@main/storage/paths'

const WS = join(userData, 'project')
const OTHER_WS = join(userData, 'elsewhere')
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
const SOURCE = 'src-run'
/** The 8-byte PNG signature and a little body: enough for the format sniff. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])

afterAll(() => rmSync(userData, { recursive: true, force: true }))

/** What the record is drawn from — loadRun's messages and loadRunEvents' rows — and what it draws. */
async function rendered(workspacePath: string, runId: string) {
  const messages = (await loadMessagesWindowAsync(workspacePath, runId)).messages
  const events = await loadEventsForRunAsync(workspacePath, runId)
  const items = applyEventTimestamps(applyPersistedLiveTools(messagesToUiItems(messages), events), events)
  // The record is the same whatever the task's id is.
  const anon = (value: unknown): unknown => JSON.parse(JSON.stringify(value).split(runId).join('RUN'))
  return { messages: anon(messages), events: anon(events), items: anon(items) }
}

async function seedSource(): Promise<void> {
  const dir = createRun(WS, SOURCE, 'Fix the **flaky** updater test')
  const at = (s: number): string => new Date(Date.UTC(2026, 8, 30, 11, 15, s)).toISOString()
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Fix the **flaky** updater test', at: at(1) },
    {
      role: 'assistant',
      content: 'Reading the test first.',
      toolCalls: [{ id: 't1', name: 'read', arguments: JSON.stringify({ path: 'tests/updater.test.ts' }) }],
      at: at(4)
    },
    { role: 'tool', toolCallId: 't1', toolName: 'read', ok: true, content: `OPENAI_API_KEY=${KEY}\nconst wait = 10`, at: at(5) },
    { role: 'assistant', content: 'The wait was too short; raised it to 50 ms.', at: at(9) }
  ]
  for (const message of messages) await appendMessage(dir, message)
  const events: Array<[number, Record<string, unknown>]> = [
    [1, { type: 'status', runId: SOURCE, invokeId: 1, status: 'running', seq: 1 }],
    [3, { type: 'thinking_done', runId: SOURCE, text: 'Look at the timing.', seq: 2 }],
    [4, { type: 'assistant_message', runId: SOURCE, invokeId: 1, step: 1, text: 'Reading the test first.', seq: 3 }],
    [5, { type: 'step_usage', runId: SOURCE, step: 1, inputTokens: 1200, outputTokens: 40, seq: 4 }],
    [9, { type: 'assistant_message', runId: SOURCE, invokeId: 1, step: 2, text: 'The wait was too short; raised it to 50 ms.', seq: 5 }],
    [10, { type: 'status', runId: SOURCE, invokeId: 1, status: 'done', seq: 6 }]
  ]
  for (const [s, event] of events) appendEvent(dir, event, at(s))
  await flushMessageAppends(dir)
  await flushEventAppends(dir)
  await updateStatus(dir, { status: 'done', step: 2 }, { sync: true })
  writeFileSync(join(dir, 'plan.md'), '## Steps\n\n1. Read the test\n2. Raise the wait\n')
  writeFileSync(
    join(dir, 'checks.json'),
    JSON.stringify({
      checks: [{ id: 'c1', text: 'The test passes ten times in a row', source: 'brief', verdict: 'met', createdAt: at(1) }]
    })
  )
  mkdirSync(join(dir, 'images'), { recursive: true })
  writeFileSync(join(dir, 'images', 'read-1-1.png'), PNG)
}

describe('task bundles (Export as JSON / Import task…)', () => {
  it('round-trips: export → import → load renders the same record, as a new read-only task', async () => {
    await seedSource()
    const bundle = await buildRunBundle(WS, SOURCE, '1.2.0', new Date('2026-10-02T09:00:00.000Z'))
    expect(bundle).toMatchObject({
      format: 'vyotiq-task',
      version: 1,
      app: { name: 'Vyotiq', version: '1.2.0' },
      task: { runId: SOURCE, title: 'Fix the flaky updater test', status: 'done', step: 2 }
    })
    const text = serializeRunBundle(bundle)
    // Secrets never leave in the file.
    expect(text).not.toContain(KEY)

    const { runId, title } = await importRunBundle(OTHER_WS, parseRunBundle(text))
    expect(runId).not.toBe(SOURCE)
    expect(title).toBe('Fix the flaky updater test')

    const before = await rendered(WS, SOURCE)
    const after = await rendered(OTHER_WS, runId)
    expect(after.items).toEqual(before.items)
    expect(after.events).toEqual(before.events)
    // The tool result was already redacted on disk, so the copies match.
    expect(after.messages).toEqual(before.messages)
    expect((after.items as unknown[]).length).toBeGreaterThan(0)

    const dir = resolveRunDir(OTHER_WS, runId)
    const status = loadStatus(dir)
    expect(status).toMatchObject({ status: 'done', step: 2, imported: { sourceRunId: SOURCE, exportedAt: '2026-10-02T09:00:00.000Z' } })
    expect(status?.resumable).toBeUndefined()
    expect(isImportedRun(OTHER_WS, runId)).toBe(true)
    expect(isImportedRun(WS, SOURCE)).toBe(false)
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('Raise the wait')
    expect(JSON.parse(readFileSync(join(dir, 'checks.json'), 'utf8')).checks[0].verdict).toBe('met')
    expect(readFileSync(join(dir, 'images', 'read-1-1.png')).equals(PNG)).toBe(true)
    // Write checkpoints are never carried: nothing in an import can undo a file here.
    expect(existsSync(join(dir, 'checkpoints'))).toBe(false)
    expect((await listRuns(OTHER_WS)).runs.map((run) => run.runId)).toContain(runId)
  })

  it('never overwrites: importing the same bundle twice, even into its own workspace, makes two new tasks', async () => {
    const bundle = parseRunBundle(serializeRunBundle(await buildRunBundle(WS, SOURCE)))
    const first = await importRunBundle(WS, bundle)
    const second = await importRunBundle(WS, bundle)
    expect(new Set([SOURCE, first.runId, second.runId]).size).toBe(3)
    expect(loadStatus(resolveRunDir(WS, SOURCE))?.imported).toBeUndefined()
  })

  it('refuses a file that is not a task bundle, one from a newer app, and a damaged one', async () => {
    const good = JSON.parse(serializeRunBundle(await buildRunBundle(WS, SOURCE))) as Record<string, unknown>
    const reject = (text: string): string => {
      try {
        parseRunBundle(text)
      } catch (err) {
        expect(err).toBeInstanceOf(RunBundleError)
        return (err as Error).message
      }
      throw new Error('accepted')
    }
    expect(reject('{ not json')).toBe('The file is not JSON.')
    expect(reject(JSON.stringify({ ...good, format: 'something-else' }))).toBe('The file is not a Vyotiq task export.')
    expect(reject(JSON.stringify({ ...good, version: 2 }))).toMatch(/newer Vyotiq \(format version 2\)/)
    expect(reject(JSON.stringify({ ...good, messages: [{ role: 'robot', content: 'x' }] }))).toMatch(/^The task file is damaged at messages\.0\.role/)
    expect(reject(JSON.stringify({ ...good, events: [{ at: 'x', event: { no: 'type' } }] }))).toMatch(/damaged at events\.0\.event\.type/)
    // An artifact must be a stored image's name: no path out of the run dir.
    expect(reject(JSON.stringify({ ...good, artifacts: [{ name: '../../evil.png', data: PNG.toString('base64') }] }))).toMatch(
      /damaged at artifacts\.0\.name/
    )
    const { task: _task, ...noTask } = good
    expect(reject(JSON.stringify(noTask))).toMatch(/damaged at task/)
  })

  it('refuses an oversized file before reading it', async () => {
    const path = join(userData, 'huge.json')
    const fd = openSync(path, 'w')
    ftruncateSync(fd, RUN_BUNDLE_MAX_BYTES + 1)
    closeSync(fd)
    await expect(readRunBundleFile(path)).rejects.toThrow(`larger than ${RUN_BUNDLE_MAX_BYTES / 1024 / 1024} MB`)
  })

  it('drops image bytes that are not an image instead of writing them', async () => {
    const bundle = parseRunBundle(serializeRunBundle(await buildRunBundle(WS, SOURCE)))
    const tampered = { ...bundle, artifacts: [{ name: 'images/read-9.png', data: Buffer.from('#!/bin/sh\necho hi').toString('base64') }] }
    const { runId } = await importRunBundle(WS, tampered)
    expect(existsSync(join(resolveRunDir(WS, runId), 'images', 'read-9.png'))).toBe(false)
  })
})

describe('an imported task is never resumed', () => {
  it('launch refuses a new instruction on it', async () => {
    vi.resetModules()
    vi.doMock('@main/workspace/workspaces', () => ({ getWorkspaces: () => ({ openPaths: [WS] }) }))
    mkdirSync(WS, { recursive: true })
    const { launchRunSync } = await import('@main/agent/launchRun')
    const state = await import('@main/agent/state')
    const bundleMod = await import('@main/agent/runBundle')
    const bundle = bundleMod.parseRunBundle(bundleMod.serializeRunBundle(await bundleMod.buildRunBundle(WS, SOURCE)))
    const { runId } = await bundleMod.importRunBundle(WS, bundle)
    const outcome = launchRunSync({
      workspacePath: WS,
      runId,
      newMessages: [{ role: 'user', content: 'keep going' }],
      incremental: true,
      wc: {} as never,
      source: 'test'
    })
    expect(outcome).toEqual({ ok: false, error: 'An imported task is read-only. Fork it to continue.', code: 'run_imported' })
    expect(state.loadStatus(resolveRunDir(WS, runId))?.status).toBe('done')
    vi.doUnmock('@main/workspace/workspaces')
  })
})
