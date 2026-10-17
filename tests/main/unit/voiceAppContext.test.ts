/**
 * The app as the agent reads it with app_control app_status (docs/voice-mode.md
 * §24.14, §27): what is on screen, the workspace and branch, other work, a few
 * settings, voice mode, the update, the time, and the rules and memory by
 * headline. Without it "is there an update?" was a guess (2026-10-16 02:37).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatAppContext, readGitBranch, ruleHeadline, spokenNow, type AppSnapshot } from '@main/voice/appContext'
import { VOICE_REPLY_TEXT } from '@main/agent/context/userRules'
import { VoiceTaskRequestSchema } from '@shared/ipc/schemas/voice'

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
  settings: { model: 'z-ai/glm-5.3-flash', approvals: 'on for every tool', theme: 'dark' },
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
      "Settings: new tasks start on z-ai/glm-5.3-flash; tool approvals are on for every tool; dark theme.",
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

  it('says voice mode, the update and what is queued when there is any, never a guess', () => {
    const text = formatAppContext({
      ...base,
      queued: 2,
      voice: { placement: 'takeover', speed: 1.25, muted: 'until_called' },
      update: { status: 'available', version: '1.4.0' }
    })
    expect(text).toContain('2 messages are queued on it, given to it at its next step.')
    expect(text).toContain('Voice mode is on, shown as takeover at 1.25 times speed, muted until called by name.')
    expect(text).toContain('Update: one is out and not downloaded (version 1.4.0).')
    expect(formatAppContext({ ...base, voice: { placement: 'capsule', speed: 1, look: 'cloud', style: 'ambient' } })).toContain(
      'Voice mode is on, shown as capsule with the cloud orb, ambient style.'
    )
    // What set_voice_options sets is read back where it isn't the default; defaults stay unsaid.
    const options = formatAppContext({
      ...base,
      settings: { skin: 'gild' },
      voice: { placement: 'takeover', speed: 1, layout: 'orb', patience: 'patient', captions: false, sounds: true, progress: true, holdToTalk: false, language: 'hi' }
    })
    expect(options).toContain('Voice options: full-screen layout orb; waits longer before you’re done; captions off; progress spoken; listens for language hi.')
    expect(options).toContain('gild skin')
    expect(
      formatAppContext({ ...base, voice: { placement: 'takeover', speed: 1, layout: 'conversation', patience: 'normal', captions: true, sounds: true, progress: false, holdToTalk: false, language: 'en' } })
    ).not.toContain('Voice options')
    expect(formatAppContext({ ...base, voice: { placement: 'takeover', speed: 1, language: '' } })).toContain('Voice options: detects the language.')
    expect(formatAppContext({ ...base, changedSince: [{ what: 'the orb', set: 'cloud', now: 'pearl' }] })).toContain(
      'Changed since you set it, by the person or another task, not by you: the orb is pearl now (you set cloud). Say so; don’t set it back unless they ask.'
    )
    expect(formatAppContext({ ...base, update: { status: 'not-available', version: '1.4.0' } })).toContain('Update: none, this is the newest.')
    expect(formatAppContext(base)).not.toMatch(/Voice mode|Update:|queued/)
  })

  it('the agent is told to read it, not guess, on a spoken turn', () => {
    expect(VOICE_REPLY_TEXT).toContain('read it with app_control app_status instead of guessing')
    expect(VOICE_REPLY_TEXT).toContain('app_status')
  })

  it('says Home’s backdrop and greeting name with the settings', () => {
    const ctx = (home: { backdrop: string; name: string }): string =>
      formatAppContext({ now: new Date('2026-10-17T10:00:00Z'), workspace: null, task: null, others: [], settings: { home }, update: { status: 'idle' }, rules: [], memory: [] } as Parameters<typeof formatAppContext>[0])
    expect(ctx({ backdrop: 'pixels', name: 'Ajay' })).toContain("Settings: Home's backdrop is pixels, it greets the user as Ajay.")
    expect(ctx({ backdrop: 'image', name: '' })).toContain("Home's backdrop is the picked picture, no greeting name")
    expect(ctx({ backdrop: 'none', name: '' })).toContain("Home's backdrop is off")
  })
})
