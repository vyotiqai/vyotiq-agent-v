import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MAX_VOICE_LOGS, VoiceConversationLog, pruneVoiceLogs } from '@main/voice/conversationLog'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-voicelog-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // Only the folders this file made.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('the kept voice conversation (§24.8)', () => {
  it('keeps why an error happened, not just its code, with secrets redacted', async () => {
    const dir = join(tempDir(), 'voice')
    const log = new VoiceConversationLog({ dir, sessionId: 's1' })
    log.add({
      kind: 'error',
      side: 'session',
      code: 'out_of_credit',
      detail: 'OpenRouter (402): needs $0.50 for audio; key sk-or-v1-' + '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    })
    await log.close()
    const [error] = lines(log.file)
    expect(error).toMatchObject({ kind: 'error', code: 'out_of_credit', detail: expect.stringContaining('needs $0.50 for audio') })
    expect(String(error!.detail)).not.toContain('0123456789abcdef0123456789abcdef')
  })

  it('writes every entry in order, stamped, ending with `end`', async () => {
    const dir = join(tempDir(), 'voice')
    const log = new VoiceConversationLog({ dir, sessionId: 's1', now: () => new Date('2026-10-14T16:52:28.000Z') })
    log.add({ kind: 'start', listener: 'openrouter', speaker: 'openrouter' })
    log.add({ kind: 'you', turnId: 't1', text: 'Explain this project.' })
    log.add({ kind: 'voice', contextId: 'c1', text: 'On it.' })
    log.add({ kind: 'hand_off', handOffId: 'h1', brief: 'Explore the codebase and explain it.' })
    log.add({ kind: 'followed', runId: 'run-1', handOffId: 'h1' })
    await log.close()
    expect(readdirSync(dir)).toEqual(['2026-10-14T16-52-28-000Z_s1.jsonl'])
    const got = lines(log.file)
    expect(got.map((l) => l.kind)).toEqual(['start', 'you', 'voice', 'hand_off', 'followed', 'end'])
    expect(got[1]).toMatchObject({ at: '2026-10-14T16:52:28.000Z', turnId: 't1', text: 'Explain this project.' })
    // Nothing more after close.
    log.add({ kind: 'you', turnId: 't2', text: 'late' })
    await log.flush()
    expect(lines(log.file)).toHaveLength(6)
  })

  it('never writes a secret that was said out loud or put in a brief', async () => {
    const dir = tempDir()
    const key = `sk-or-${'a1B2c3D4'.repeat(5)}`
    const log = new VoiceConversationLog({ dir, sessionId: 's2' })
    log.add({ kind: 'you', turnId: 't1', text: `use the key ${key}` })
    log.add({ kind: 'hand_off', handOffId: 'h1', brief: `Set OPENROUTER_API_KEY to ${key}` })
    await log.close()
    const text = readFileSync(log.file, 'utf8')
    expect(text).not.toContain(key)
  })

  it('batches writes: nothing waits on the disk per entry', async () => {
    const dir = tempDir()
    const log = new VoiceConversationLog({ dir, sessionId: 's3' })
    for (let i = 0; i < 50; i++) log.add({ kind: 'voice', contextId: 'c', text: `sentence ${i}` })
    // Buffered, not yet written.
    await new Promise((r) => setTimeout(r, 0))
    expect(readdirSync(dir)).toEqual([])
    await log.flush()
    expect(lines(log.file)).toHaveLength(50)
  })

  it('keeps the newest logs per workspace, and only its own files', async () => {
    const dir = tempDir()
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `2026-10-1${i}T00-00-00-000Z_s${i}.jsonl`), '{}\n')
    writeFileSync(join(dir, 'notes.txt'), 'not a log')
    await pruneVoiceLogs(dir, 3)
    expect(readdirSync(dir).sort()).toEqual([
      '2026-10-12T00-00-00-000Z_s2.jsonl',
      '2026-10-13T00-00-00-000Z_s3.jsonl',
      '2026-10-14T00-00-00-000Z_s4.jsonl',
      'notes.txt'
    ])
    expect(MAX_VOICE_LOGS).toBeGreaterThan(50)
  })

  it('a folder it can’t write to costs the session nothing', async () => {
    const dir = tempDir()
    const blocked = join(dir, 'file-not-folder')
    writeFileSync(blocked, '')
    const log = new VoiceConversationLog({ dir: blocked, sessionId: 's4' })
    log.add({ kind: 'you', turnId: 't1', text: 'hello' })
    await expect(log.close()).resolves.toBeUndefined()
  })
})
