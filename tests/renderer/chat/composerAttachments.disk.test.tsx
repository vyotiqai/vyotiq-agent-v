/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearComposerAttachments,
  composerAttachmentKey,
  flushComposerAttachmentsToDisk,
  getComposerAttachments,
  resetComposerAttachmentStoreForTests,
  seedComposerAttachmentsFromDisk,
  setComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'

type SetPayload = { workspacePath: string; buckets: Record<string, unknown> }
type ClearPayload = { workspacePath: string; key: string }

const calls = {
  set: [] as SetPayload[],
  clear: [] as ClearPayload[]
}

function installFakeApi(buckets: Record<string, unknown> = {}): void {
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    getComposerAttachments: async (workspacePath: string) => ({
      ok: true as const,
      data: { buckets: JSON.parse(JSON.stringify(buckets)) as Record<string, unknown> }
    }),
    setComposerAttachments: async (payload: SetPayload) => {
      calls.set.push(payload)
      return { ok: true as const, data: true }
    },
    clearComposerAttachments: async (payload: ClearPayload) => {
      calls.clear.push(payload)
      return { ok: true as const, data: true }
    }
  }
}

const WS = '/ws/disk'
const draftKey = composerAttachmentKey(WS, null)!

const emptyBucket = { images: [], files: [], nativeFiles: [], audio: [] }

beforeEach(() => {
  resetComposerAttachmentStoreForTests()
  calls.set = []
  calls.clear = []
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

afterEach(() => {
  resetComposerAttachmentStoreForTests()
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

describe('composer attachment disk persistence', () => {
  it('seeds persisted buckets into memory on workspace open', async () => {
    installFakeApi({ 'run-1': { ...emptyBucket, images: ['img-1'] } })
    await seedComposerAttachmentsFromDisk(WS)
    expect(getComposerAttachments(`${WS}::run-1`).images).toEqual(['img-1'])
  })

  it('never clobbers newer in-memory state during seed', async () => {
    installFakeApi({ __draft__: { ...emptyBucket, images: ['disk'] } })
    setComposerAttachments(draftKey, { images: ['local'] })
    await seedComposerAttachmentsFromDisk(WS)
    expect(getComposerAttachments(draftKey).images).toEqual(['local'])
  })

  it('pushes edits to the sidecar after the debounce window', async () => {
    installFakeApi()
    await seedComposerAttachmentsFromDisk(WS)
    setComposerAttachments(draftKey, { images: ['a'] })
    await flushComposerAttachmentsToDisk()
    expect(calls.set).toHaveLength(1)
    expect(calls.set[0]!.workspacePath).toBe(WS)
    expect(calls.set[0]!.buckets).toEqual({
      __draft__: { ...emptyBucket, images: ['a'] }
    })
  })

  it('propagates a fully-emptied bucket as a delete map', async () => {
    installFakeApi({ __draft__: { ...emptyBucket, images: ['disk'] } })
    await seedComposerAttachmentsFromDisk(WS)
    setComposerAttachments(draftKey, { images: [] })
    await flushComposerAttachmentsToDisk()
    expect(calls.set).toHaveLength(1)
    expect(calls.set[0]!.buckets).toEqual({})
  })

  it('skips pushes before the workspace seed succeeded (race safety)', async () => {
    // No seed call — a push now would send a partial map and wipe disk keys.
    setComposerAttachments(draftKey, { images: ['a'] })
    await flushComposerAttachmentsToDisk()
    expect(calls.set).toHaveLength(0)
  })

  it('clears the persisted bucket on send-time clear', async () => {
    installFakeApi({ __draft__: { ...emptyBucket, images: ['disk'] } })
    await seedComposerAttachmentsFromDisk(WS)
    clearComposerAttachments(draftKey)
    expect(getComposerAttachments(draftKey).images).toEqual([])
    expect(calls.clear).toEqual([{ workspacePath: WS, key: '__draft__' }])
  })

  it('clears memory only on workspace close (disk survives for re-open)', async () => {
    installFakeApi({ __draft__: { ...emptyBucket, images: ['disk'] } })
    await seedComposerAttachmentsFromDisk(WS)
    const { clearComposerAttachmentsForWorkspace } = await import(
      '@renderer/lib/hooks/composerAttachmentStore'
    )
    clearComposerAttachmentsForWorkspace(WS)
    expect(getComposerAttachments(draftKey).images).toEqual([])
    expect(calls.clear).toEqual([])
    // Re-open re-seeds from disk.
    await seedComposerAttachmentsFromDisk(WS)
    expect(getComposerAttachments(draftKey).images).toEqual(['disk'])
  })
})
