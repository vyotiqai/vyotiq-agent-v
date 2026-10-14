import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VoiceConversationLog } from '@main/voice/conversationLog'
import { listVoiceConversations, parseVoiceLog, readVoiceConversation, summarizeVoiceLog } from '@main/voice/conversationHistory'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-voicehist-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // Only the folders this file made.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function writeSession(dir: string, sessionId: string, at: string, fill: (log: VoiceConversationLog) => void): Promise<string> {
  const log = new VoiceConversationLog({ dir, sessionId, now: () => new Date(at) })
  fill(log)
  await log.close()
  return log.file
}

describe('kept voice conversations, read back (§24.8)', () => {
  it('reads what the writer wrote, every kind, in order', async () => {
    const dir = join(tempDir(), 'voice')
    await writeSession(dir, 's1', '2026-10-14T16:52:28.000Z', (log) => {
      log.add({ kind: 'start', listener: 'openrouter', speaker: 'openrouter' })
      log.add({ kind: 'you', turnId: 't1', text: 'Explain this project.' })
      log.add({ kind: 'voice', contextId: 'c1', text: 'On it.' })
      log.add({ kind: 'hand_off', handOffId: 'h1', brief: 'Explore the codebase and explain it.' })
      log.add({ kind: 'followed', runId: 'run-1', handOffId: 'h1' })
      log.add({ kind: 'agent', contextId: 'a1', text: 'It is an Electron app.' })
      log.add({ kind: 'answered', what: 'approval', text: 'yes', decision: 'once', tool: 'terminal' })
      log.add({ kind: 'stop_agent', by: 'you' })
      log.add({ kind: 'dropped', reason: 'echo', chars: 12 })
      log.add({ kind: 'error', side: 'listener', code: 'network' })
      log.add({ kind: 'hand_off', handOffId: 'h2', brief: 'Run the tests.' })
      log.add({ kind: 'not_sent', handOffId: 'h2', reason: 'refused' })
    })
    const got = await readVoiceConversation(dir, '2026-10-14T16-52-28-000Z_s1')
    expect(got).not.toBeNull()
    expect(got!.skipped).toBe(0)
    expect(got!.entries.map((e) => e.kind)).toEqual([
      'start', 'you', 'voice', 'hand_off', 'followed', 'agent', 'answered', 'stop_agent', 'dropped', 'error', 'hand_off', 'not_sent', 'end'
    ])
    expect(got!.summary).toMatchObject({
      id: '2026-10-14T16-52-28-000Z_s1',
      startedAt: '2026-10-14T16:52:28.000Z',
      endedAt: '2026-10-14T16:52:28.000Z',
      turns: 1,
      firstWords: 'Explain this project.',
      runIds: ['run-1'],
      sent: [{ runId: 'run-1', brief: 'Explore the codebase and explain it.' }],
      handOffs: 2,
      notSent: 1
    })
  })

  it('lists newest first and skips files that are not conversations', async () => {
    const dir = join(tempDir(), 'voice')
    await writeSession(dir, 'old', '2026-10-13T09:00:00.000Z', (log) => log.add({ kind: 'you', turnId: 't', text: 'first' }))
    await writeSession(dir, 'new', '2026-10-14T09:00:00.000Z', (log) => log.add({ kind: 'you', turnId: 't', text: 'second' }))
    writeFileSync(join(dir, 'notes.jsonl'), '{}\n')
    writeFileSync(join(dir, 'readme.txt'), 'x')
    // A folder with a conversation's name is not read as one.
    mkdirSync(join(dir, '2026-10-15T09-00-00-000Z_dir.jsonl'))
    const list = await listVoiceConversations(dir)
    expect(list.map((c) => c.firstWords)).toEqual(['second', 'first'])
  })

  it('a missing folder is no conversations yet', async () => {
    expect(await listVoiceConversations(join(tempDir(), 'nope'))).toEqual([])
  })

  it('never reads outside the folder, whatever the id says', async () => {
    const root = tempDir()
    const dir = join(root, 'voice')
    mkdirSync(dir)
    writeFileSync(join(root, 'secret.jsonl'), `${JSON.stringify({ at: 'x', kind: 'you', turnId: 't', text: 'secret' })}\n`)
    for (const id of ['../secret', '..\\secret', 'secret', '/etc/passwd', 'C:\\x', '2026-10-14T16-52-28-000Z_../../secret', '']) {
      expect(await readVoiceConversation(dir, id)).toBeNull()
    }
  })

  it('a torn last line or an unknown kind is skipped and counted, not trusted', async () => {
    const dir = join(tempDir(), 'voice')
    const file = await writeSession(dir, 's2', '2026-10-14T10:00:00.000Z', (log) => log.add({ kind: 'you', turnId: 't', text: 'hello' }))
    appendFileSync(file, `${JSON.stringify({ at: 'x', kind: 'mystery' })}\n{"at":"x","kind":"you","te`)
    const got = await readVoiceConversation(dir, '2026-10-14T10-00-00-000Z_s2')
    expect(got!.entries.map((e) => e.kind)).toEqual(['you', 'end'])
    expect(got!.skipped).toBe(2)
  })

  it('a followed with no hand-off id takes the latest open hand-off; with none it keeps no brief', () => {
    const { entries } = parseVoiceLog(
      [
        { at: 'a', kind: 'hand_off', handOffId: 'h1', brief: 'one' },
        { at: 'b', kind: 'followed', runId: 'r1' },
        { at: 'c', kind: 'followed', runId: 'r1' }
      ]
        .map((l) => JSON.stringify(l))
        .join('\n')
    )
    expect(summarizeVoiceLog('2026-10-14T10-00-00-000Z_x', entries).sent).toEqual([
      { runId: 'r1', brief: 'one' },
      { runId: 'r1', brief: '' }
    ])
  })

  it('a session that never wrote a line still lists, dated by its file name', () => {
    expect(summarizeVoiceLog('2026-10-14T16-52-28-000Z_s1', [])).toMatchObject({ startedAt: '2026-10-14T16:52:28.000Z', endedAt: null, turns: 0 })
  })
})
