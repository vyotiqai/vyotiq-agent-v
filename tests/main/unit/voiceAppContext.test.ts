/**
 * The voice knows the app, not only the task (batch 2, docs/voice-mode.md
 * §24.14): what is on screen, the workspace and branch, other work, a few
 * settings, the time, and the rules and memory by headline. Before this,
 * "what branch am I on?" or "is anything else running?" went to the agent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatAppContext, readGitBranch, ruleHeadline, spokenNow, type AppSnapshot } from '@main/voice/appContext'
import { RESPONDER_SYSTEM, type ResponderChat, type ResponderChunk } from '@main/voice/responder'
import { VoiceSession } from '@main/voice/session'
import { openFixtureStt, type FixtureSttSession } from '@main/voice/providers/fixture'
import type { SttOpenOptions, TtsStream } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS, VoiceTaskRequestSchema, type VoiceScreen } from '@shared/ipc/schemas/voice'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'vyotiq-voice-app-'))
  dirs.push(d)
  return d
}

const NOW = new Date(2026, 9, 15, 19, 5)
const base: AppSnapshot = {
  now: NOW,
  screen: 'task',
  workspace: { name: 'VYOTIQ - AGENT V', branch: 'main' },
  task: { title: 'Fix the voice stop', state: 'waiting' },
  others: [{ title: 'Write the release notes', workspace: 'site', state: 'running' }],
  settings: { model: 'z-ai/glm-5.3-flash', approvals: 'on for every tool', theme: 'dark', voicePlacement: 'takeover', voiceSpeed: 1.25 },
  rules: ['CLAUDE.md (UI design rules)'],
  memory: ['Voice stop reaches the run']
}

describe('the app, as the voice reads it', () => {
  it('says the time, the screen, the workspace and branch, other work, settings, rules and memory', () => {
    const text = formatAppContext(base)
    expect(text.split('\n')).toEqual([
      `(The app right now, ${spokenNow(NOW)}:)`,
      'On screen: the task “Fix the voice stop”, stopped until the user answers.',
      'Workspace: VYOTIQ - AGENT V, on branch main.',
      'Other tasks: “Write the release notes” in site (running).',
      "Settings: the agent's model is z-ai/glm-5.3-flash; tool approvals are on for every tool; dark theme; voice shows as takeover at 1.25 times speed.",
      'Project rules the agent follows: CLAUDE.md (UI design rules).',
      "The agent's memory notes here: Voice stop reaches the run."
    ])
    expect(spokenNow(NOW)).toMatch(/^Thursday 15 October 2026, 7:05 pm$/)
  })

  it('names other screens, says when nothing else runs, and keeps lists to headlines', () => {
    const others = Array.from({ length: 9 }, (_, i) => ({ title: `Task ${i}`, workspace: 'w', state: 'running' as const }))
    const text = formatAppContext({ ...base, screen: 'new_task', task: null, others, rules: [], memory: [] })
    expect(text).toContain('On screen: New task, nothing started yet.')
    expect(text).toContain('“Task 5” in w (running); and 3 more.')
    expect(text).not.toContain('Task 6')
    expect(text).not.toContain('Project rules')
    expect(formatAppContext({ ...base, screen: 'settings', others: [] })).toContain('On screen: Settings.\n')
    expect(formatAppContext({ ...base, others: [] })).toContain('No other tasks are running.')
  })

  it('never carries a secret', () => {
    expect(formatAppContext({ ...base, memory: ['key sk-or-v1-' + '0123456789abcdef0123456789abcdef'] })).not.toContain('0123456789abcdef0123')
  })

  it('reads the branch from HEAD, in a subfolder, a worktree, or detached; nothing outside a repo', () => {
    const repo = tmp()
    mkdirSync(join(repo, '.git'))
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/voice\n')
    mkdirSync(join(repo, 'src'))
    expect(readGitBranch(repo)).toBe('feat/voice')
    expect(readGitBranch(join(repo, 'src'))).toBe('feat/voice')
    const wt = tmp()
    mkdirSync(join(repo, '.git', 'worktrees', 'x'), { recursive: true })
    writeFileSync(join(repo, '.git', 'worktrees', 'x', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n')
    writeFileSync(join(wt, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'x')}\n`)
    expect(readGitBranch(wt)).toBe('none, detached at 0123456')
    expect(readGitBranch(join(tmp(), 'nowhere'))).toBeUndefined()
  })

  it('a rules file is its name and first heading, past any frontmatter', () => {
    expect(ruleHeadline('.cursor/rules/evidence-minimal.mdc', '---\nalwaysApply: true\n---\n# Evidence only\nbody')).toBe('evidence-minimal.mdc (Evidence only)')
    expect(ruleHeadline('CLAUDE.md', '')).toBe('CLAUDE.md')
  })

  it('the window can say what is on screen with the task', () => {
    expect(VoiceTaskRequestSchema.parse({ sessionId: 's', runId: null, screen: 'new_task' }).screen).toBe('new_task')
    expect(() => VoiceTaskRequestSchema.parse({ sessionId: 's', runId: null, screen: 'desktop' })).toThrow()
  })

  it('the voice is told it has it, and not to read it out', () => {
    expect(RESPONDER_SYSTEM).toContain('With every turn you get the app as it is now')
    expect(RESPONDER_SYSTEM).toContain('never read it out unasked')
  })
})

const tick = () => new Promise((r) => setTimeout(r, 0))
const silentTts = (): TtsStream =>
  ({ pushText: () => {}, flush: () => {}, end: () => {}, cancel: () => {}, done: () => Promise.resolve() }) as unknown as TtsStream

describe('a session keeps the app fresh', () => {
  it('reads it on start, with the task and screen, and as you start talking; the voice gets it with your turn', async () => {
    const asked: Array<{ runId: string | null; workspacePath: string | null; screen: VoiceScreen | null }> = []
    const statuses: string[] = []
    const chat: ResponderChat = (req) => {
      statuses.push(req.status)
      return (async function* (): AsyncGenerator<ResponderChunk> {
        yield { type: 'text', text: 'You’re on main.' }
      })()
    }
    const stt: FixtureSttSession[] = []
    let clock = 0
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
      responder: () => chat,
      loadAppContext: async (where) => {
        asked.push(where)
        return `(The app right now:)\nOn screen: ${where.screen ?? 'unknown'}; read ${asked.length}.`
      },
      setTimer: () => null,
      clearTimer: () => {},
      newId: () => `id${++n}`,
      now: () => clock
    })
    await session.start()
    expect(asked).toEqual([{ runId: null, workspacePath: null, screen: null }])
    session.setTask('run-1', 'C:/work', 'task')
    expect(asked.at(-1)).toEqual({ runId: 'run-1', workspacePath: 'C:/work', screen: 'task' })
    // Only the screen moved: read again.
    session.setTask('run-1', 'C:/work', 'settings')
    expect(asked.at(-1)).toMatchObject({ screen: 'settings' })
    const reads = asked.length
    clock += 10_000
    await tick()
    // You talk for a moment before the turn ends.
    stt.at(-1)!.say('What branch am I on?', false)
    await tick()
    stt.at(-1)!.endTurn()
    await tick()
    // Talking read it once more, and the turn carries it.
    expect(asked.length).toBe(reads + 1)
    expect(statuses[0]).toContain(`On screen: settings; read ${reads + 1}.`)
  })
})
