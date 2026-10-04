/**
 * End-to-end: the real messages.jsonl / events.jsonl write path, driven
 * through the exported helpers in src/main/agent/state.ts (and the event
 * queue it delegates to). No production file is modified to run this — it
 * imports the shipped writers and reads what actually landed on disk.
 *
 * Where the unit-level shapes are pinned in redactTranscript.test.ts, this
 * file answers the question that only the real path can: does a credential
 * that a tool or a fetched page handed the model survive to disk?
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vy-transcript-redaction-'))

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
import { REDACTED_SECRET } from '@shared/utils/redactSecrets'
import {
  appendEvent,
  appendMessage,
  createRun,
  flushEventAppends,
  flushMessageAppends,
  loadMessagesAsync
} from '@main/agent/state'

const WS = join(userData, 'project')
const R = REDACTED_SECRET

afterAll(() => rmSync(userData, { recursive: true, force: true }))

const raw = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

/** 91 chars, base64, decoding to printable prose — the incident's shape. */
const FETCHED_TOKEN = Buffer.from(
  'ExampleTokenFromVendorDocumentationNotARealCredential'.padEnd(68, 'x'),
  'utf8'
)
  .toString('base64')
  .replace(/=+$/, '')

describe('a credential the model received from a tool result', () => {
  it('never reaches messages.jsonl, but still reaches the model', async () => {
    const dir = createRun(WS, 'run-fetched', 'check the OAuth docs')
    // What the model actually received: a fetched page, tool output.
    const fetchedDoc = [
      'curl --request POST \\',
      `  --header 'Authorization: Bearer ${FETCHED_TOKEN}' \\`,
      '  https://api.x.com/2/oauth2/token'
    ].join('\n')
    const toolResult: ChatMessage = {
      role: 'tool',
      toolCallId: 't1',
      content: `HTTP/1.1 200 OK\n\n${fetchedDoc}\n`
    }

    await appendMessage(dir, toolResult)
    await flushMessageAppends(dir)

    // On disk: the scheme word survives so the record still reads correctly,
    // the credential does not.
    const onDisk = raw(dir, 'messages.jsonl')
    expect(onDisk).not.toContain(FETCHED_TOKEN)
    expect(onDisk).toContain(`Bearer ${R}`)
    const stored = JSON.parse(onDisk.trim()) as ChatMessage
    expect(stored.content).toBe(`HTTP/1.1 200 OK\n\ncurl --request POST \\\n  --header 'Authorization: Bearer ${R}' \\\n  https://api.x.com/2/oauth2/token\n`)

    // In memory: untouched. The step that read it still has the real value.
    expect(toolResult.content).toContain(FETCHED_TOKEN)

    // And the row is still valid JSONL, not a broken line.
    expect(onDisk.trimEnd().split('\n')).toHaveLength(1)
    expect(() => JSON.parse(onDisk)).not.toThrow()
  })

  it('is redacted on a tool-call argument and on a tool_start event too', async () => {
    const dir = createRun(WS, 'run-args', 'call the API')
    const key = 'sk-ant-api03-AbCdEf0123456789AbCdEf0123456789'
    const call: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 't1', name: 'terminal', arguments: JSON.stringify({ command: `curl -H "x-api-key: ${key}" https://api.anthropic.com` }) }
      ]
    }
    await appendMessage(dir, call)
    await flushMessageAppends(dir)

    // The arguments string is redacted as text, and stays parseable JSON —
    // otherwise the model's own next turn could not replay the call.
    expect(raw(dir, 'messages.jsonl')).not.toContain(key)
    const stored = JSON.parse(raw(dir, 'messages.jsonl').trim()) as ChatMessage
    const args = JSON.parse(stored.toolCalls![0]!.arguments) as { command: string }
    expect(args.command).toBe(`curl -H "x-api-key: ${R}" https://api.anthropic.com`)

    appendEvent(dir, { type: 'tool_output', toolCallId: 't1', output: `export GITHUB_TOKEN=ghp_${'0123456789abcdefghij'.repeat(2)}` })
    await flushEventAppends(dir)
    expect(raw(dir, 'events.jsonl')).not.toContain('ghp_')
  })

  it('leaves ordinary tool output byte-identical', async () => {
    const dir = createRun(WS, 'run-ordinary', 'run the suite')
    const output = [
      'PASS tests/shared/redactSecrets.test.ts',
      'workspace 1d7ca570-0fbb-5a0a-ba71-439305604d17',
      'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      "const config = { api_key: 'fake-consumer-key-0123456789' }",
      "ipcMain.handle('mcp:setOAuthClientSecret', handler)",
      'The retry constant Xk9QmZvTpLr4WdNhBsYc looked wrong to me.'
    ].join('\n')
    const result: ChatMessage = { role: 'tool', toolCallId: 't1', content: output }

    await appendMessage(dir, result)
    await flushMessageAppends(dir)

    // Byte-identical: not merely unredacted, but unchanged.
    const stored = JSON.parse(raw(dir, 'messages.jsonl').trim()) as ChatMessage
    expect(stored.content).toBe(output)
  })
})

describe('a record read back from disk is stable', () => {
  it('resuming re-reads the placeholder and re-appending does not double-wrap', async () => {
    const dir = createRun(WS, 'run-resume', 'read the env file')
    const result: ChatMessage = {
      role: 'tool',
      toolCallId: 't1',
      content: `Authorization: Bearer ${FETCHED_TOKEN}`
    }
    await appendMessage(dir, result)
    await flushMessageAppends(dir)

    const once = raw(dir, 'messages.jsonl')
    const resumed = await loadMessagesAsync(WS, 'run-resume')
    expect(resumed[0]!.content).toBe(`Authorization: Bearer ${R}`)

    // Re-appending what was just read back (a compaction or rewind path that
    // re-appends stored rows) must not turn one placeholder into two.
    await appendMessage(dir, resumed[0]!)
    await flushMessageAppends(dir)
    const rows = raw(dir, 'messages.jsonl')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ChatMessage)
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.content).toBe(`Authorization: Bearer ${R}`)
      // Exactly one placeholder in the row: no double-wrap, no growth.
      expect(String(row.content).split(R).length - 1).toBe(1)
    }
    // The original row was unchanged by the redaction being applied twice.
    expect(JSON.parse(once.trim()).content).toBe(`Authorization: Bearer ${R}`)
  })
})

describe('DEVIATION — the redactor is not role-aware', () => {
  // Documented, not endorsed. redactForRecord walks every string in the
  // record regardless of role, so a USER message that legitimately contains a
  // token — pasted to be debugged, or a fixture someone is hunting for — is
  // rewritten on disk too. The audit brief said user text must be left alone.
  // It is not. This test pins what actually happens so the behaviour cannot
  // drift silently; if the parent decides to make redaction role-aware, this
  // assertion is the one that should fail.
  it('rewrites a user message that contains a real-looking key', async () => {
    const dir = createRun(WS, 'run-user-token', 'why does this 401?')
    const pasted = 'my key is sk-ant-api03-AbCdEf0123456789AbCdEf0123456789, is it revoked?'
    const userMessage: ChatMessage = { role: 'user', content: pasted }

    await appendMessage(dir, userMessage)
    await flushMessageAppends(dir)

    const stored = JSON.parse(raw(dir, 'messages.jsonl').trim()) as ChatMessage
    expect(stored.content).toBe(`my key is ${R}, is it revoked?`)
    // The run keeps what the user typed, so the live turn is unaffected.
    expect(userMessage.content).toBe(pasted)
  })
})