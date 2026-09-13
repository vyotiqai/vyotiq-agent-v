import { rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `vyotiq-attstore-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

import {
  clearComposerAttachmentsForWorkspace,
  listComposerAttachmentsForWorkspace,
  setComposerAttachmentsForWorkspace
} from '@main/attachments/composerStore'
import { COMPOSER_ATTACHMENT_MAX_BUCKETS } from '@shared/ipc'

const workspace = join(userData, 'repo')

const bucketWith = (image: string) => ({
  images: [image],
  files: [],
  nativeFiles: [],
  audio: []
})

beforeEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('composer attachment sidecar store', () => {
  it('returns no buckets when nothing was persisted', async () => {
    await expect(listComposerAttachmentsForWorkspace(workspace)).resolves.toEqual({})
  })

  it('roundtrips a bucket and strips internal bookkeeping', async () => {
    const bucket = {
      images: ['data:image/png;base64,x'],
      files: [{ type: 'file' as const, name: 'a.md', mime: 'text/markdown', text: 'hi' }],
      nativeFiles: [],
      audio: []
    }
    await setComposerAttachmentsForWorkspace(workspace, { 'run-1': bucket })
    await expect(listComposerAttachmentsForWorkspace(workspace)).resolves.toEqual({
      'run-1': bucket
    })
  })

  it('replaces the whole map — keys absent from the payload are deleted', async () => {
    await setComposerAttachmentsForWorkspace(workspace, {
      'run-1': bucketWith('a'),
      'run-2': bucketWith('b')
    })
    await setComposerAttachmentsForWorkspace(workspace, { 'run-1': bucketWith('a2') })
    const buckets = await listComposerAttachmentsForWorkspace(workspace)
    expect(Object.keys(buckets)).toEqual(['run-1'])
    expect(buckets['run-1']!.images).toEqual(['a2'])
  })

  it('skips empty buckets in the payload and clears the file when all are empty', async () => {
    await setComposerAttachmentsForWorkspace(workspace, {
      'run-1': bucketWith('a'),
      'run-2': { images: [], files: [], nativeFiles: [], audio: [] }
    })
    expect(Object.keys(await listComposerAttachmentsForWorkspace(workspace))).toEqual(['run-1'])
    await setComposerAttachmentsForWorkspace(workspace, {})
    await expect(listComposerAttachmentsForWorkspace(workspace)).resolves.toEqual({})
  })

  it('clear removes only the named key', async () => {
    await setComposerAttachmentsForWorkspace(workspace, {
      'run-1': bucketWith('a'),
      'run-2': bucketWith('b')
    })
    await clearComposerAttachmentsForWorkspace(workspace, 'run-1')
    const buckets = await listComposerAttachmentsForWorkspace(workspace)
    expect(Object.keys(buckets)).toEqual(['run-2'])
  })

  it('evicts the oldest bucket beyond the cap', async () => {
    let acc: Record<string, { images: string[]; files: []; nativeFiles: []; audio: [] }> = {}
    for (let i = 0; i <= COMPOSER_ATTACHMENT_MAX_BUCKETS; i++) {
      acc = { ...acc, [`k${i}`]: bucketWith(`img-${i}`) }
      await setComposerAttachmentsForWorkspace(workspace, acc)
    }
    const buckets = await listComposerAttachmentsForWorkspace(workspace)
    expect(Object.keys(buckets)).toHaveLength(COMPOSER_ATTACHMENT_MAX_BUCKETS)
    expect(buckets.k0).toBeUndefined()
    expect(buckets[`k${COMPOSER_ATTACHMENT_MAX_BUCKETS}`]).toBeDefined()
  })

  it('ignores a corrupt sidecar instead of failing reads', async () => {
    await setComposerAttachmentsForWorkspace(workspace, { 'run-1': bucketWith('a') })
    const { workspaceAttachmentsDir } = await import('@main/storage/paths')
    const { writeFileSync } = await import('fs')
    writeFileSync(join(workspaceAttachmentsDir(workspace), 'composer.json'), '{ not json', 'utf8')
    await expect(listComposerAttachmentsForWorkspace(workspace)).resolves.toEqual({})
  })
})
