/**
 * Voice mode is the agent (docs/voice-mode.md §27, 2026-10-16 decision): the
 * agent is told it is the one you talk to and does the work itself, reads the
 * app rather than guessing, and in voice mode a commit or a push waits for a
 * spoken yes whatever the approval settings say.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolApprovalRequest } from '@shared/ipc'
import { commitsOrPushes, createApprovalGate, registerApprovalSender, resetToolApprovalForTests, resolveToolApproval } from '@main/agent/toolApproval'
import { VOICE_REPLY_TEXT } from '@main/agent/context/userRules'
import { isVoiceFollowedRun, onSpokenTurnState, setVoiceFollowedRun, spokenTurnStateText } from '@main/voice/voiceReply'
import { spokenTurnThinking } from '@main/agent/loopPolicy'

describe('the agent, on a spoken turn', () => {
  it('is told it is the one you talk to, and never to hand anything off', () => {
    expect(VOICE_REPLY_TEXT).toContain('You are Agent V')
    expect(VOICE_REPLY_TEXT).toContain('There is no separate voice and no other agent')
    expect(VOICE_REPLY_TEXT).toContain('Never say you will hand something off')
    expect(VOICE_REPLY_TEXT).toContain('Say a thing is done only once a tool result shows it')
    // 2026-10-16 probe: asked which orb it used, it answered from memory of setting it, without reading the app.
    expect(VOICE_REPLY_TEXT).toContain('even what you set yourself earlier')
    // The next probe: shown pearl, it set cloud again unasked and said "the status I read was stale".
    expect(VOICE_REPLY_TEXT).toContain('the person changed it since: say what it is now and never set it back unless they ask')
    expect(VOICE_REPLY_TEXT).toContain('Don’t invent a reason for anything'.replace('’', "'"))
  })

  it('knows a task’s model from the model new tasks start with, and has the app’s actions without a lookup', () => {
    expect(VOICE_REPLY_TEXT).toContain('set_task_model; set_model only changes the model new tasks start with')
    expect(VOICE_REPLY_TEXT).toContain('set_task_model {model, task?}')
    expect(VOICE_REPLY_TEXT).toContain('voice_mute {until?: called|unmuted}')
  })

  it('answers you between its steps when you speak while it works', () => {
    expect(VOICE_REPLY_TEXT).toContain('answer them first, in a short <spoken> block at the start of your next message')
  })
})

describe('the app as it is, on each step of a spoken turn (2026-10-16 probe: "cloud" said from memory, the orb was pearl)', () => {
  afterEach(() => onSpokenTurnState(null))

  it('reads it fresh for each step, and is empty when nothing reads it or the read fails', async () => {
    expect(await spokenTurnStateText('r1', 'C:/work')).toBe('')
    let look = 'cloud'
    onSpokenTurnState(async (runId, ws) => `(The app right now:) ${runId} ${ws} orb ${look}`)
    expect(await spokenTurnStateText('r1', 'C:/work')).toBe('(The app right now:) r1 C:/work orb cloud')
    look = 'pearl'
    expect(await spokenTurnStateText('r1', 'C:/work')).toContain('orb pearl')
    onSpokenTurnState(async () => {
      throw new Error('no window')
    })
    expect(await spokenTurnStateText('r1', 'C:/work')).toBe('')
  })
})

describe('reasoning on a spoken turn (2026-10-16: 4.2–8.5 s a step at the set effort)', () => {
  it('is off where the model allows it, else the lowest effort it lists', () => {
    expect(spokenTurnThinking({ supportsThinking: true })).toEqual({ enabled: false })
    expect(spokenTurnThinking({ supportsThinking: true, thinkingCanDisable: true })).toEqual({ enabled: false })
    expect(spokenTurnThinking({ supportsThinking: true, thinkingCanDisable: false, supportedThinkingEfforts: ['high', 'low', 'medium'] })).toEqual({
      enabled: true,
      effort: 'low',
      display: 'omitted'
    })
    expect(spokenTurnThinking({ supportsThinking: true, thinkingCanDisable: false })).toMatchObject({ enabled: true, effort: 'low' })
    expect(spokenTurnThinking(undefined)).toEqual({ enabled: false })
  })
})

describe('commits and pushes in voice mode', () => {
  afterEach(() => {
    setVoiceFollowedRun('s1', null)
    resetToolApprovalForTests()
  })

  it('knows a commit or a push from a command that only mentions one', () => {
    expect(commitsOrPushes('git_commit', {})).toBe(true)
    expect(commitsOrPushes('github_pr_create', {})).toBe(true)
    expect(commitsOrPushes('terminal', { command: 'git commit -m "fix"' })).toBe(true)
    expect(commitsOrPushes('terminal', { command: 'git -C app push origin main' })).toBe(true)
    expect(commitsOrPushes('terminal', { command: 'pnpm test && git push' })).toBe(true)
    expect(commitsOrPushes('terminal', { command: 'git log --grep commit' })).toBe(false)
    expect(commitsOrPushes('terminal', { command: 'git status' })).toBe(false)
    expect(commitsOrPushes('read', { path: 'commit.ts' })).toBe(false)
  })

  function gate(runId: string) {
    const seen: ToolApprovalRequest[] = []
    registerApprovalSender(runId, (request) => {
      seen.push(request)
      queueMicrotask(() => resolveToolApproval({ requestId: request.requestId, runId, decision: 'once' }))
    })
    // Approvals off: nothing asks, unless it must.
    const g = createApprovalGate({ runId, mode: 'off', workspaceAllowlist: [], signal: new AbortController().signal })
    return { g, seen }
  }

  it('waits for a yes while voice mode follows the run, approvals off or not', async () => {
    setVoiceFollowedRun('s1', 'run-v')
    expect(isVoiceFollowedRun('run-v')).toBe(true)
    const { g, seen } = gate('run-v')
    const r = await g.authorize({ id: 'c1', name: 'git_commit', arguments: JSON.stringify({ message: 'fix: voice' }) })
    expect(r.allowed).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.danger).toContain('commits or pushes')
    // Reading is never held.
    const read = await g.authorize({ id: 'c2', name: 'read', arguments: JSON.stringify({ path: 'a.ts' }) })
    expect(read.allowed).toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('without voice mode, approvals off means it runs without asking, as before', async () => {
    expect(isVoiceFollowedRun('run-t')).toBe(false)
    const { g, seen } = gate('run-t')
    const r = await g.authorize({ id: 'c1', name: 'git_commit', arguments: JSON.stringify({ message: 'fix' }) })
    expect(r.allowed).toBe(true)
    expect(seen).toHaveLength(0)
  })
})
