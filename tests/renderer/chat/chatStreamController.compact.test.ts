/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { parseDiffPreview, parseEditCardData } from '@renderer/features/chat/toolUi'

async function flushStreamPatches(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

describe('createChatStreamController', () => {
  it('clears stale overflow on applyManualCompaction', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({
      type: 'context_usage',
      runId: 'r1',
      step: 2,
      estimatedTokens: 90_000,
      inputTokens: 90_000,
      contextWindow: 128_000,
      contentWindow: 85_000,
      compactionTrigger: 85_000,
      source: 'provider',
      overflow: true,
      layers: { system: 5_000, history: 70_000, tools: 5_000, buffer: 19_200 }
    })
    expect(controller.getContextUsage()?.overflow).toBe(true)

    controller.setCompacting(true)
    expect(controller.compacting).toBe(true)

    controller.applyManualCompaction({
      summary: 'Prior turns covered the auth refactor.',
      tokenEstimate: 800,
      estimatedTokens: 12_000,
      contextWindow: 128_000,
      contentWindow: 85_000
    })
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    const compactItem = controller.items.find((item) => item.kind === 'compaction')
    expect(compactItem?.kind === 'compaction' ? compactItem.summary : null).toBe(
      'Prior turns covered the auth refactor.'
    )
    expect(compactItem?.kind === 'compaction' ? compactItem.at : null).toMatch(/^\d{4}-/)
    const usage = controller.getContextUsage()
    expect(usage?.overflow).toBe(false)
    expect(usage?.used).toBe(12_000)
    expect(usage?.source).toBe('estimate')
  })

  it('derives the auto-compact trigger, not the content window, on a cold manual compact', () => {
    // No prior context_usage, so this takes the cold branch that builds the
    // meter state from scratch. It used to store the content window here, which
    // overstates "free before auto-compact" by ~1.8x.
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.applyManualCompaction({
      summary: 'Folded the auth refactor.',
      tokenEstimate: 800,
      estimatedTokens: 12_000,
      contextWindow: 1_000_000,
      contentWindow: 850_000
    })
    const usage = controller.getContextUsage()
    expect(usage?.contentWindow).toBe(850_000)
    expect(usage?.compactionTrigger).toBe(467_500)
  })

  it('does not keep idle hydrate compacting from a leftover compaction_started', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'hi' }], [
      {
        at: '2026-08-12T00:00:00.000Z',
        event: { type: 'compaction_started', runId: 'r1', mode: 'manual' }
      }
    ])
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    expect(controller.items.some((item) => item.kind === 'compaction')).toBe(false)
  })

  it('clears compacting and keeps a failed compact card when verification fails', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'Forgot JWT'
    })
    controller.handleEvent({
      type: 'compaction_verify_retry',
      runId: 'r1',
      summary: 'Forgot JWT',
      failures: ['Missing decision: Use JWT']
    })
    expect(controller.compacting).toBe(true)
    controller.handleEvent({
      type: 'compaction_verify_failed',
      runId: 'r1',
      summary: 'Forgot JWT',
      failures: ['Missing decision: Use JWT']
    })
    expect(controller.compacting).toBe(false)
    const failed = controller.items.find((item) => item.kind === 'compaction')
    expect(failed?.kind === 'compaction' ? failed.verifyStatus : null).toBe('failed')
    expect(failed?.kind === 'compaction' ? failed.verifyFailures : null).toEqual([
      'Missing decision: Use JWT'
    ])
  })

  it('clears compacting on terminal status after an in-flight fold', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    expect(controller.compacting).toBe(true)
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'cancelled' })
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
  })
  it('settles a verifying compact card when the run is cancelled', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'draft fold'
    })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'cancelled' })
    expect(controller.compacting).toBe(false)
    const compact = controller.items.find((item) => item.kind === 'compaction')
    expect(compact?.kind === 'compaction' ? compact.verifyStatus : null).toBe('failed')
    expect(compact?.kind === 'compaction' ? compact.id : null).not.toBe('compaction:in-flight')
    expect(compact?.kind === 'compaction' ? compact.verifyFailures : null).toEqual([
      'Summary was not applied.'
    ])
  })

  it('clears stale verifyFailures when a later verifying event has none', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'compaction_started', runId: 'r1', mode: 'auto' })
    controller.handleEvent({
      type: 'compaction_verify_retry',
      runId: 'r1',
      summary: 'draft',
      failures: ['Missing decision: Use JWT']
    })
    controller.handleEvent({
      type: 'compaction_verifying',
      runId: 'r1',
      summary: 'draft'
    })
    const live = controller.items.find((item) => item.kind === 'compaction')
    expect(live?.kind === 'compaction' ? live.verifyStatus : null).toBe('verifying')
    expect(live?.kind === 'compaction' ? live.verifyFailures : undefined).toBeUndefined()
  })

  it('keeps a failed compact card when a later verified fold uses the same summary', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({
      type: 'compaction_verify_failed',
      runId: 'r1',
      summary: 'Same text',
      failures: ['Missing decision: Use JWT']
    })
    controller.handleEvent({
      type: 'compaction',
      runId: 'r1',
      summary: 'Same text',
      kind: 'summary',
      verified: true,
      verifyCoverage: 1
    })
    const cards = controller.items.filter((item) => item.kind === 'compaction')
    expect(cards).toHaveLength(2)
    expect(cards.map((item) => (item.kind === 'compaction' ? item.verifyStatus : null))).toEqual([
      'failed',
      'verified'
    ])
  })

  it('hydrates compact success as a transcript summary item, not runNotice', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'hi' }], [
      {
        at: '2026-08-12T00:00:00.000Z',
        event: { type: 'compaction_started', runId: 'r1', mode: 'auto' }
      },
      {
        at: '2026-08-12T00:00:01.000Z',
        event: { type: 'compaction', runId: 'r1', summary: 'folded history of auth work', kind: 'summary' }
      }
    ])
    expect(controller.compacting).toBe(false)
    expect(controller.runNotice).toBeNull()
    const compactItem = controller.items.find((item) => item.kind === 'compaction')
    expect(compactItem?.kind === 'compaction' ? compactItem.summary : null).toBe(
      'folded history of auth work'
    )
  })

  it('merges unresolved writes_checkpoint rows on hydrate', async () => {
    const listActiveRuns = vi.fn().mockResolvedValue({ ok: true, data: [] })
    const loadRun = vi.fn().mockResolvedValue({
      ok: true,
      data: { messages: [], status: 'done' }
    })
    const loadRunEvents = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        {
          at: '2026-01-01T00:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'r1',
            checkpointId: 'cp-old',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-01-02T00:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'r1',
            checkpointId: 'cp-new',
            files: [{ path: 'b.ts', action: 'modified', undoable: true }]
          }
        }
      ]
    })
    // @ts-expect-error test bridge
    window.vyotiq = {
      ...(window.vyotiq as object),
      chatCancel: vi.fn().mockResolvedValue({ ok: true, data: true }),
      listActiveRuns,
      loadRun,
      loadRunEvents
    }

    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    await controller.syncFromDisk('r1')

    expect(controller.writeCheckpoint?.checkpointId).toBe('cp-new')
    expect(controller.writeCheckpoint?.files.map((f) => f.path).sort()).toEqual(['a.ts', 'b.ts'])
    expect(controller.runId).toBe('r1')
  })
})
