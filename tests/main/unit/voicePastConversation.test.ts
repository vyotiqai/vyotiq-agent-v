/**
 * A new voice session on a task picks up the last one (eighth audit,
 * 2026-10-15): Ajay stopped wrong work, ended, opened voice again four
 * seconds later and said "Continue.", and the voice handed the same work back
 * because it remembered nothing. The kept conversation also loses the turns
 * the voice left unanswered, which the live view marks.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { lastConversationForRun, pastConversationMessages, parseVoiceLog } from '@main/voice/conversationHistory'
import { VoiceResponder, type ResponderChat, type ResponderChunk } from '@main/voice/responder'
import { VoiceSession } from '@main/voice/session'
import type { VoiceLogEntry } from '@main/voice/conversationLog'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS } from '@shared/ipc/schemas/voice'
import type { ChatMessage } from '@shared/ipc'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function folder(files: Record<string, object[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-voice-past-'))
  dirs.push(dir)
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'))
  return dir
}

const at = '2026-10-15T11:17:02.609Z'
const stoppedSession = [
  { at, kind: 'start', listener: 'openrouter', speaker: 'openrouter' },
  { at, kind: 'task', runId: 'run-a' },
  { at, kind: 'you', turnId: 't1', text: 'Can you change theme to black?' },
  { at, kind: 'voice', contextId: 'c1', text: 'Sure, I’ll have the agent switch it.' },
  { at, kind: 'voice', contextId: 'c1', text: 'It’s on it.' },
  { at, kind: 'hand_off', handOffId: 'h1', brief: 'Change the project theme to dark.' },
  { at, kind: 'followed', runId: 'run-a', handOffId: 'h1' },
  { at, kind: 'you', turnId: 't2', text: 'No, I mean your system theme.' },
  { at, kind: 'you', turnId: 't3', text: 'Stop it.', stop: true },
  { at, kind: 'stop_agent', by: 'you' },
  { at, kind: 'end' }
]

describe('the last conversation on a task', () => {
  it('is found by its task, newest first, never this session’s own', async () => {
    const dir = folder({
      '2026-10-15T11-00-00-000Z_old': [{ at, kind: 'task', runId: 'run-a' }, { at, kind: 'you', turnId: 'x', text: 'older' }],
      '2026-10-15T11-15-05-915Z_s1': stoppedSession,
      '2026-10-15T11-16-00-000Z_other': [{ at, kind: 'task', runId: 'run-b' }],
      '2026-10-15T11-17-59-570Z_s2': [{ at, kind: 'task', runId: 'run-a' }]
    })
    const found = await lastConversationForRun(dir, 'run-a', 's2')
    expect(found?.id).toBe('2026-10-15T11-15-05-915Z_s1')
    expect(await lastConversationForRun(dir, 'run-z')).toBeNull()
  })

  it('becomes the voice’s memory: your words, its replies joined, the hand-off and the stop', () => {
    const { entries } = parseVoiceLog(stoppedSession.map((l) => JSON.stringify(l)).join('\n'))
    expect(pastConversationMessages(entries)).toEqual([
      { role: 'user', content: 'Can you change theme to black?' },
      { role: 'assistant', content: 'Sure, I’ll have the agent switch it. It’s on it.\n(Handed to the agent: Change the project theme to dark.)' },
      { role: 'user', content: 'No, I mean your system theme.\nStop it.' },
      { role: 'assistant', content: '(The user stopped the agent’s work.)' }
    ])
  })
})

function fakeModel() {
  const calls: Array<{ messages: ChatMessage[]; system: string }> = []
  const chat: ResponderChat = (req) => {
    calls.push({ messages: req.messages, system: req.system })
    return (async function* (): AsyncGenerator<ResponderChunk> {
      yield { type: 'text', text: 'What should it do instead?' }
    })()
  }
  return { chat, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const silentTts = (): TtsStream =>
  ({ pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }) as unknown as TtsStream

describe('a new session on the same task', () => {
  it('starts from the last conversation, so "Continue." is answered knowing you stopped it', async () => {
    const model = fakeModel()
    const stt: FixtureSttSession[] = []
    const recorded: VoiceLogEntry[] = []
    const { entries } = parseVoiceLog(stoppedSession.map((l) => JSON.stringify(l)).join('\n'))
    let n = 0
    const session = new VoiceSession({
      emit: () => {},
      settings: () => ({ ...DEFAULT_VOICE_SETTINGS, sttProvider: 'openrouter' }),
      keys: () => ({ voice: {}, chat: { openrouter: true } }),
      readKey: () => 'k',
      sttProvider: (id) => ({
        id,
        open: async (o: SttOpenOptions) => {
          const s = await openFixtureStt(o)
          stt.push(s)
          return s
        }
      }),
      openTts: () => silentTts(),
      responder: () => model.chat,
      loadPastConversation: async (runId) => (runId === 'run-a' ? pastConversationMessages(entries) : []),
      record: (e) => recorded.push(e),
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${++n}`
    })
    await session.start()
    session.setTask('run-a')
    await tick()
    expect(recorded).toContainEqual({ kind: 'task', runId: 'run-a' })
    stt.at(-1)!.say('Continue.')
    await tick()
    const sent = model.calls[0]!.messages
    expect(sent[0]!.content).toContain('last voice conversation on this task')
    expect(sent.map((m) => m.content).join('\n')).toContain('(The user stopped the agent’s work.)')
    expect(sent.at(-1)).toEqual({ role: 'user', content: 'Continue.' })
    expect(model.calls[0]!.system).toContain('if the user stopped that work')
  })

  it('recall never overwrites what this session already said', () => {
    const r = new VoiceResponder({
      chat: () => null,
      openTts: () => null,
      say: () => {},
      handOff: () => {},
      stopAgent: () => {},
      done: () => {},
      agentStatus: () => ({ working: false }),
      newId: () => 'x',
      now: () => 0
    })
    r.respond('Hello there.')
    r.recall([{ role: 'user', content: 'old' }])
    // No voice model: the turn went to the agent as its brief; nothing old was added before it.
    expect((r as unknown as { history: ChatMessage[] }).history.map((m) => m.content)).toEqual(['Hello there.'])
  })
})

describe('a kept conversation read back', () => {
  it('an error keeps the provider’s reason when read back', () => {
    const { entries } = parseVoiceLog(JSON.stringify({ at, kind: 'error', side: 'session', code: 'out_of_credit', detail: 'Add credit' }))
    expect(entries[0]).toMatchObject({ kind: 'error', detail: 'Add credit' })
  })
})
