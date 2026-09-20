import { describe, expect, it } from 'vitest'
import {
  AgentProfileSnapshotSchema,
  RunStatusSchema,
  RunSummarySchema
} from '@shared/ipc'
import { resolveTurnModel, validateExistingRunStart } from '@main/agent/loop'

const snapshot = {
  version: 1 as const,
  id: 'scout',
  name: 'Scout',
  persona: 'Investigate carefully.',
  scope: 'global' as const,
  runtime: 'local' as const
}

describe('agent profile persistence schemas', () => {
  it('validates timestamp-free snapshots and workspace scope', () => {
    expect(AgentProfileSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(
      AgentProfileSnapshotSchema.safeParse({
        ...snapshot,
        scope: 'workspace',
        workspacePath: undefined
      }).success
    ).toBe(false)
    expect(
      AgentProfileSnapshotSchema.safeParse({ ...snapshot, createdAt: 'ignored' }).data
    ).not.toHaveProperty('createdAt')
  })

  it('uses filesystem-safe profile ids on statuses and summaries', () => {
    expect(RunStatusSchema.safeParse({ status: 'done', step: 0, updatedAt: 'now', agentProfileId: '../bad' }).success).toBe(false)
    expect(RunSummarySchema.safeParse({ runId: 'run', status: 'done', updatedAt: 'now', agentProfileId: '../bad' }).success).toBe(false)
    expect(RunSummarySchema.parse({ runId: 'run', status: 'done', updatedAt: 'now', agentProfileId: 'scout', agentProfileSnapshot: snapshot, runtime: 'local' })).toMatchObject({ agentProfileId: 'scout', runtime: 'local' })
  })
})

describe('existing run profile invariants', () => {
  const persisted = RunStatusSchema.parse({
    status: 'cancelled',
    step: 2,
    updatedAt: 'now',
    agentProfileId: 'scout',
    agentProfileSnapshot: snapshot,
    runtime: 'local'
  })

  it('recovers omitted binding/runtime and rejects explicit changes', () => {
    expect(validateExistingRunStart(persisted, {}, { agentProfileId: false, runtime: false })).toEqual({
      agentProfileId: 'scout',
      runtime: 'local'
    })
    expect(() => validateExistingRunStart(persisted, { agentProfileId: 'other' }, { agentProfileId: true, runtime: false })).toThrow('teammate binding cannot be changed')
    expect(() => validateExistingRunStart(persisted, { runtime: 'cloud' }, { agentProfileId: false, runtime: true })).toThrow('runtime cannot be changed')
  })
})

describe('turn model precedence', () => {
  const fallback = { provider: 'openai' as const, model: 'global-default' }
  const profilePin = { provider: 'anthropic' as const, model: 'pinned-model' }

  it('lets a teammate pin beat the renderer default on the first turn', () => {
    // The renderer always sends its ambient default in `requested`. Without the
    // explicit flag it is indistinguishable from a choice, and the pin would
    // never apply to the very run that defines the teammate.
    expect(
      resolveTurnModel({
        requested: { provider: 'openai', model: 'renderer-default' },
        explicit: false,
        recalled: null,
        profilePin,
        fallback
      })
    ).toEqual(profilePin)
  })

  it('lets a hand-picked model beat the teammate pin', () => {
    expect(
      resolveTurnModel({
        requested: { provider: 'openai', model: 'user-choice' },
        explicit: true,
        recalled: null,
        profilePin,
        fallback
      })
    ).toEqual({ provider: 'openai', model: 'user-choice' })
  })

  it("keeps a resumed turn on the run's persisted selection", () => {
    const recalled = { provider: 'openai' as const, model: 'session-model' }
    expect(
      resolveTurnModel({
        requested: { provider: 'openai', model: 'renderer-default' },
        explicit: false,
        recalled,
        profilePin,
        fallback
      })
    ).toEqual(recalled)
  })

  it('still honours an explicit change on a run that already has a selection', () => {
    expect(
      resolveTurnModel({
        requested: { provider: 'anthropic', model: 'switched-to' },
        explicit: true,
        recalled: { provider: 'openai', model: 'session-model' },
        profilePin,
        fallback
      })
    ).toEqual({ provider: 'anthropic', model: 'switched-to' })
  })

  it('falls back to the renderer value, then global, with no pin or recall', () => {
    expect(
      resolveTurnModel({
        requested: { provider: 'anthropic', model: 'renderer-default' },
        explicit: false,
        recalled: null,
        profilePin: null,
        fallback
      })
    ).toEqual({ provider: 'anthropic', model: 'renderer-default' })
    expect(
      resolveTurnModel({ requested: {}, explicit: false, recalled: null, profilePin: null, fallback })
    ).toEqual(fallback)
  })
})
