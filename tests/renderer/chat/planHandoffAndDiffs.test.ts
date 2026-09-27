import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'

function tool(
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: 'done' | 'running' = 'done'
): Extract<UiItem, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    at: Date.now(),
    tool: {
      toolCallId: id,
      name,
      status,
      summary: typeof args.path === 'string' ? args.path : name,
      argsPreview: JSON.stringify(args)
    }
  }
}

describe('collectSessionChangedFiles', () => {
  it('keeps created when a later edit modifies the same path', async () => {
    const { mergeChangedFileAction } = await import(
      '@renderer/features/chat/utils/turnFileDiffs'
    )
    expect(mergeChangedFileAction('created', 'modified')).toBe('created')
    expect(mergeChangedFileAction('created', 'deleted')).toBe('deleted')
  })

  it('marks successful deletes as deleted', async () => {
    const { collectSessionChangedFiles } = await import(
      '@renderer/features/chat/utils/turnFileDiffs'
    )
    const files = collectSessionChangedFiles([
      { kind: 'message', id: 'u1', role: 'user', content: 'remove', at: 1 },
      tool('t1', 'delete', { path: 'src/gone.ts' })
    ])
    expect(files).toEqual([{ path: 'src/gone.ts', added: 0, removed: 1, action: 'deleted' }])
  })
})

describe('mergeCheckpointChangedFiles', () => {
  it('adds checkpoint-only paths to tool-arg changed files', async () => {
    const { mergeCheckpointChangedFiles } = await import(
      '@renderer/features/chat/utils/turnFileDiffs'
    )
    const toolFiles = [{ path: 'src/a.ts', added: 2, removed: 1, action: 'modified' as const }]
    const checkpoint = [
      { path: 'src/a.ts', action: 'modified' as const },
      { path: 'dist/out.js', action: 'created' as const }
    ]
    const merged = mergeCheckpointChangedFiles(toolFiles, checkpoint)
    expect(merged.some((f) => f.path === 'dist/out.js')).toBe(true)
    // Checkpoint-only paths carry no invented line counts.
    expect(merged.find((f) => f.path === 'dist/out.js')).toEqual({
      path: 'dist/out.js',
      action: 'created'
    })
  })
})
