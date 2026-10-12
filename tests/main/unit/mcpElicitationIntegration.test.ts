import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import type { AgentQuestionAnswer, AgentQuestionRequest } from '@shared/ipc'
import {
  connectMcpServer,
  invokeMcpTool,
  listMcpToolDefinitions,
  mcpToolName,
  resetMcpSessionsForTests,
  setOpenElicitedLinkForTests,
  setSamplingModelSource,
  shutdownMcpServers,
  type McpAsker
} from '@main/agent/mcp'

const fixture = join(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures/mcp-elicit-server.mjs')
const server = {
  id: 'elicit',
  name: 'Bookings',
  enabled: true,
  transport: 'stdio' as const,
  command: process.execPath,
  args: [fixture],
  env: {}
}

afterEach(async () => {
  await shutdownMcpServers()
  resetMcpSessionsForTests()
})

function asker(answer: (req: AgentQuestionRequest, n: number) => AgentQuestionAnswer[], over: Partial<McpAsker> = {}) {
  const asked: AgentQuestionRequest[] = []
  const a: McpAsker = {
    runId: 'run-1',
    toolCallId: 'call-1',
    signal: new AbortController().signal,
    ask: async (req) => {
      asked.push(req)
      return answer(req, asked.length)
    },
    ...over
  }
  return { a, asked }
}

const call = (tool: string, a?: McpAsker) =>
  invokeMcpTool('elicit', tool, {}, new AbortController().signal, undefined, undefined, undefined, undefined, a)

const serverSaw = (content: string): unknown => JSON.parse(/\{[\s\S]*\}/.exec(content)![0])

describe('MCP elicitation and tool list changes, against a real stdio server', () => {
  it('shows the server’s form to the task that called it and returns typed values', async () => {
    await connectMcpServer(server)
    const { a, asked } = asker(() => [
      { questionId: 'f0', values: ['4'] },
      { questionId: 'f1', values: ['Outside'] }
    ])
    const result = await call('book', a)
    expect(result.ok).toBe(true)
    expect(serverSaw(result.content)).toEqual({ action: 'accept', content: { guests: 4, seating: 'out' } })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ runId: 'run-1', toolCallId: 'call-1', title: 'Bookings asks' })
    expect(asked[0]!.questions[0]!.prompt).toContain('Book a table?')
  }, 30_000)

  it('asks again with the reason when an answer does not fit, and Skip declines', async () => {
    await connectMcpServer(server)
    const retry = asker((_req, n) => [{ questionId: 'f0', values: [n === 1 ? '12' : '2'] }])
    expect(serverSaw((await call('book', retry.a)).content)).toEqual({ action: 'accept', content: { guests: 2 } })
    expect(retry.asked.map((r) => r.title)).toEqual(['Bookings asks', 'Bookings asks — Guests should be at most 8'])

    const skip = asker(() => [
      { questionId: 'f0', values: [] },
      { questionId: 'f1', values: [] }
    ])
    expect(serverSaw((await call('book', skip.a)).content)).toEqual({ action: 'decline' })
  }, 30_000)

  it('declines without asking when no task is calling, or the task is unattended with questions skipped', async () => {
    await connectMcpServer(server)
    expect(serverSaw((await call('book')).content)).toEqual({ action: 'decline' })
    const unattended = asker(() => [], { skipQuestions: () => true })
    expect(serverSaw((await call('book', unattended.a)).content)).toEqual({ action: 'decline' })
    expect(unattended.asked).toHaveLength(0)
  }, 30_000)

  it('a stopped task cancels the question', async () => {
    await connectMcpServer(server)
    const stop = new AbortController()
    const waiting = asker(() => [], {
      signal: stop.signal,
      ask: (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          setTimeout(() => stop.abort(), 50)
        })
    })
    expect(serverSaw((await call('book', waiting.a)).content)).toEqual({ action: 'cancel' })
  }, 30_000)

  it('shows a server’s link, opens it only on yes, and never an http one', async () => {
    await connectMcpServer(server)
    const opened: string[] = []
    setOpenElicitedLinkForTests(async (url) => {
      opened.push(url)
    })
    try {
      const yes = asker((req) => [{ questionId: 'open', values: [req.questions[0]!.options![0]!] }])
      const accepted = await call('signin', yes.a)
      expect(yes.asked[0]!.title).toBe('Bookings asks you to open a link')
      expect(yes.asked[0]!.questions[0]!.prompt).toContain('https://example.com/auth?state=1')
      expect(serverSaw(accepted.content)).toEqual({ action: 'accept' })
      expect(opened).toEqual(['https://example.com/auth?state=1'])

      const no = asker((req) => [{ questionId: 'open', values: [req.questions[0]!.options![1]!] }])
      expect(serverSaw((await call('signin', no.a)).content)).toEqual({ action: 'decline' })

      const plain = asker(() => [])
      expect(serverSaw((await call('signin-plain', plain.a)).content)).toEqual({ action: 'decline' })
      expect(plain.asked).toHaveLength(0)
      expect(opened).toHaveLength(1)
    } finally {
      setOpenElicitedLinkForTests(null)
    }
  }, 30_000)

  it('answers a sampling request with the model only once the person allows it', async () => {
    await connectMcpServer(server)
    const asked: Array<{ system?: string; text: string; max: number }> = []
    setSamplingModelSource(() => ({
      complete: async (req) => {
        asked.push({ system: req.system, text: String(req.messages[0]!.content), max: req.maxOutputTokens })
        return { text: 'Booked for four people.', model: 'test-model', stopReason: 'endTurn' }
      }
    }))
    try {
      const yes = asker((req) => [{ questionId: 'sample', values: [req.questions[0]!.options![0]!] }])
      const allowed = serverSaw((await call('summarize', yes.a)).content) as Record<string, unknown>
      expect(yes.asked[0]!.title).toBe('Bookings asks your model to answer something')
      expect(yes.asked[0]!.questions[0]!.prompt).toContain('Summarize: the table is booked for four.')
      expect(allowed).toMatchObject({ role: 'assistant', model: 'test-model', content: { type: 'text', text: 'Booked for four people.' } })
      expect(asked).toEqual([{ system: 'Answer in five words.', text: 'Summarize: the table is booked for four.', max: 50 }])

      const no = asker((req) => [{ questionId: 'sample', values: [req.questions[0]!.options![1]!] }])
      const denied = serverSaw((await call('summarize', no.a)).content) as { error?: string }
      expect(denied.error).toMatch(/Sampling declined/)
      expect(asked).toHaveLength(1)
    } finally {
      setSamplingModelSource(() => null)
    }
  }, 30_000)

  it('follows notifications/tools/list_changed: a tool added at runtime is callable without reconnecting', async () => {
    await connectMcpServer(server)
    const extra = mcpToolName('elicit', 'extra')
    expect(listMcpToolDefinitions().some((t) => t.name === extra)).toBe(false)
    expect((await call('grow')).ok).toBe(true)
    await vi.waitFor(() => expect(listMcpToolDefinitions().some((t) => t.name === extra)).toBe(true), { timeout: 10_000 })
    const doubled = await invokeMcpTool('elicit', 'extra', { n: 21 }, new AbortController().signal)
    expect(doubled.ok).toBe(true)
    expect(doubled.content).toContain('42')
  }, 30_000)
})
