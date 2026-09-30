import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vy-redact-state-'))

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

import type { ChatMessage, PersistedEvent } from '@shared/ipc'
import { REDACTED_SECRET } from '@shared/utils/redactSecrets'
import {
  appendEvent,
  appendMessage,
  createRun,
  flushEventAppends,
  flushMessageAppends,
  loadCompaction,
  loadMessagesAsync,
  saveCompaction,
  syncEventsAsync,
  syncMessagesAsync
} from '@main/agent/state'

const WS = join(userData, 'project')
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'

afterAll(() => rmSync(userData, { recursive: true, force: true }))

const lines = (dir: string, file: string): string[] =>
  readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean)

describe('task records on disk keep no secrets', () => {
  it('messages: appended and rewritten rows are redacted, the run’s own objects are not, and a resume reads the placeholder', async () => {
    const dir = createRun(WS, 'run-msg', 'read the env file')
    const toolResult: ChatMessage = { role: 'tool', toolCallId: 't1', content: `OPENAI_API_KEY=${KEY}\nPORT=3000` }
    const call: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 't2', name: 'terminal', arguments: JSON.stringify({ command: `curl -H "x-api-key: ${KEY}" https://api.anthropic.com` }) }]
    }
    await appendMessage(dir, toolResult)
    await appendMessage(dir, call)
    await flushMessageAppends(dir)

    expect(toolResult.content).toContain(KEY)
    expect(call.toolCalls![0]!.arguments).toContain(KEY)
    const raw = readFileSync(join(dir, 'messages.jsonl'), 'utf8')
    expect(raw).not.toContain(KEY)
    const [storedResult, storedCall] = lines(dir, 'messages.jsonl').map((l) => JSON.parse(l) as ChatMessage)
    expect(storedResult!.content).toBe(`OPENAI_API_KEY=${REDACTED_SECRET}\nPORT=3000`)
    expect(JSON.parse(storedCall!.toolCalls![0]!.arguments).command).toContain(REDACTED_SECRET)

    // A resume rebuilds history from disk: the model sees the placeholder.
    const resumed = await loadMessagesAsync(WS, 'run-msg')
    expect(resumed[0]!.content).toBe(`OPENAI_API_KEY=${REDACTED_SECRET}\nPORT=3000`)

    // A rewrite (rewind, compaction) goes through the same filter.
    await syncMessagesAsync(dir, [toolResult])
    expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).not.toContain(KEY)
  })

  it('events: the row is redacted and keeps the seq of the event the loop sends on', async () => {
    const dir = createRun(WS, 'run-evt', 'x')
    const event = { type: 'tool_output', toolCallId: 't1', output: `token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB` }
    appendEvent(dir, event)
    await flushEventAppends(dir)
    const row = JSON.parse(lines(dir, 'events.jsonl')[0]!) as { event: { output: string; seq: number } }
    expect(row.event.output).toBe(`token ${REDACTED_SECRET}`)
    expect(event.output).toContain('ghp_')
    expect(row.event.seq).toBe((event as { seq?: number }).seq)

    await syncEventsAsync(dir, [{ at: new Date().toISOString(), event } as unknown as PersistedEvent])
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).not.toContain('ghp_')
  })

  it('a brief’s key reaches neither the contract nor the task title', () => {
    const dir = createRun(WS, 'run-brief', `Call the API with ${KEY}`)
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toContain(`Call the API with ${REDACTED_SECRET}`)
    expect(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')).goal).toBe(`Call the API with ${REDACTED_SECRET}`)
  })

  it('a compaction summary is redacted too', () => {
    const dir = createRun(WS, 'run-cmp', 'x')
    expect(saveCompaction(dir, { summary: `Configured the client with ${KEY}.`, createdAt: new Date().toISOString(), tokenEstimate: 10 })).toBe(true)
    expect(loadCompaction(dir)!.summary).toBe(`Configured the client with ${REDACTED_SECRET}.`)
  })
})
