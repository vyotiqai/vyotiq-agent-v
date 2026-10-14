import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `vyotiq-drafts-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      return tmpdir()
    }
  }
}))

import { ChatStartRequestSchema, TASK_DRAFTS_MAX, TaskDraftSaveRequestSchema } from '@shared/ipc'
import { deleteTaskDraft, listTaskDrafts, saveTaskDraft } from '@main/drafts/taskDrafts'
import { workspaceId, workspaceMetaDir } from '@main/storage/paths'
import { canonicalizeWorkspacePath } from '@shared/workspacePath'

const workspace = join(userData, 'repo')
const draftsFile = (): string => join(workspaceMetaDir(workspaceId(canonicalizeWorkspacePath(workspace))), 'drafts.json')

beforeEach(() => {
  mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('task drafts', () => {
  it('saves a new draft, updates it by id, lists newest first and deletes it', async () => {
    const first = await saveTaskDraft(
      { workspacePath: workspace, brief: 'Fix the updater test', doneWhen: ['20 green runs'] },
      new Date('2026-09-24T10:00:00Z')
    )
    const second = await saveTaskDraft(
      { workspacePath: workspace, brief: 'Rename the palette', doneWhen: [] },
      new Date('2026-09-24T11:00:00Z')
    )
    expect((await listTaskDrafts(workspace)).map((d) => d.brief)).toEqual(['Rename the palette', 'Fix the updater test'])

    const updated = await saveTaskDraft(
      { workspacePath: workspace, id: first.id, brief: 'Fix the updater test on Windows', doneWhen: ['20 green runs', 'No retry added'] },
      new Date('2026-09-24T12:00:00Z')
    )
    expect(updated.id).toBe(first.id)
    expect(updated.createdAt).toBe(first.createdAt)
    const listed = await listTaskDrafts(workspace)
    expect(listed.map((d) => d.id)).toEqual([first.id, second.id])
    expect(listed[0]).toMatchObject({ brief: 'Fix the updater test on Windows', doneWhen: ['20 green runs', 'No retry added'] })

    expect(await deleteTaskDraft(workspace, first.id)).toBe(true)
    expect(await deleteTaskDraft(workspace, first.id)).toBe(false)
    expect((await listTaskDrafts(workspace)).map((d) => d.id)).toEqual([second.id])
  })

  it('keeps attachments only when there are some, and never loses a save to another', async () => {
    const [a, b] = await Promise.all([
      saveTaskDraft({
        workspacePath: workspace,
        brief: 'With a picture',
        doneWhen: [],
        attachments: { images: ['data:image/png;base64,AAAA'], files: [], nativeFiles: [], audio: [] }
      }),
      saveTaskDraft({
        workspacePath: workspace,
        brief: 'Without',
        doneWhen: [],
        attachments: { images: [], files: [], nativeFiles: [], audio: [] }
      })
    ])
    const listed = await listTaskDrafts(workspace)
    expect(listed.map((d) => d.id).sort()).toEqual([a.id, b.id].sort())
    expect(listed.find((d) => d.id === a.id)?.attachments?.images).toEqual(['data:image/png;base64,AAAA'])
    expect(listed.find((d) => d.id === b.id)?.attachments).toBeUndefined()
  })

  it('keeps the newest drafts past the cap and skips entries it cannot read', async () => {
    for (let i = 0; i < TASK_DRAFTS_MAX + 2; i++) {
      await saveTaskDraft({ workspacePath: workspace, brief: `Draft ${i}`, doneWhen: [] }, new Date(Date.UTC(2026, 8, 24, 0, i)))
    }
    const listed = await listTaskDrafts(workspace)
    expect(listed).toHaveLength(TASK_DRAFTS_MAX)
    expect(listed[0]!.brief).toBe(`Draft ${TASK_DRAFTS_MAX + 1}`)

    const raw = JSON.parse(readFileSync(draftsFile(), 'utf8')) as { drafts: unknown[] }
    writeFileSync(draftsFile(), JSON.stringify({ version: 1, drafts: [{ id: 'x' }, ...raw.drafts] }))
    expect(await listTaskDrafts(workspace)).toHaveLength(TASK_DRAFTS_MAX)
  })

  it('lives under the app data for the workspace, never in the project', async () => {
    await saveTaskDraft({ workspacePath: workspace, brief: 'Here', doneWhen: [] })
    expect(existsSync(draftsFile())).toBe(true)
    expect(existsSync(join(workspace, 'drafts.json'))).toBe(false)
  })
})

describe('where a draft runs', () => {
  it('keeps extra folders and the worktree choice, and drops them when a later save clears them', async () => {
    const extra = join(userData, 'shared-lib')
    const saved = await saveTaskDraft({ workspacePath: workspace, brief: 'Bump the lib', doneWhen: [], extraRoots: [extra], worktree: true })
    expect(saved).toMatchObject({ extraRoots: [extra], worktree: true })
    expect((await listTaskDrafts(workspace))[0]).toMatchObject({ extraRoots: [extra], worktree: true })

    const cleared = await saveTaskDraft({ workspacePath: workspace, id: saved.id, brief: 'Bump the lib', doneWhen: [], extraRoots: [] })
    expect(cleared.extraRoots).toBeUndefined()
    expect(cleared.worktree).toBeUndefined()
    const raw = JSON.parse(readFileSync(draftsFile(), 'utf8')) as unknown
    expect(JSON.stringify(raw)).not.toContain('extraRoots')
  })

  it('keeps worktree: false as a choice, not as absent', async () => {
    const saved = await saveTaskDraft({ workspacePath: workspace, brief: 'Here, not in a worktree', doneWhen: [], worktree: false })
    expect(saved.worktree).toBe(false)
  })

  it('refuses more extra folders than a task can take', () => {
    const roots = Array.from({ length: 64 }, (_, i) => join(userData, `f${i}`))
    expect(TaskDraftSaveRequestSchema.safeParse({ workspacePath: workspace, brief: 'x', doneWhen: [], extraRoots: roots }).success).toBe(false)
  })
})

describe('draft requests', () => {
  it('refuses an empty draft', () => {
    expect(TaskDraftSaveRequestSchema.safeParse({ workspacePath: workspace, brief: '   ', doneWhen: [] }).success).toBe(false)
    expect(TaskDraftSaveRequestSchema.safeParse({ workspacePath: workspace, brief: '', doneWhen: ['A check'] }).success).toBe(true)
  })

  it('takes a draft id only on a new task', () => {
    const base = { messages: [{ role: 'user', content: 'Go' }], workspacePath: workspace }
    expect(ChatStartRequestSchema.safeParse({ ...base, draftId: '0f3c2a1b-aaaa-4bbb-8ccc-1234567890ab' }).success).toBe(true)
    expect(
      ChatStartRequestSchema.safeParse({ ...base, runId: 'run-1', draftId: '0f3c2a1b-aaaa-4bbb-8ccc-1234567890ab' }).success
    ).toBe(false)
  })
})
