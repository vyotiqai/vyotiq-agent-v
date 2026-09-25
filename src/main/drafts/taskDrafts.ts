import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  TASK_DRAFTS_MAX,
  TaskDraftSchema,
  type TaskDraft,
  type TaskDraftSaveRequest
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { workspaceId, workspaceMetaDir } from '../storage/paths'

/**
 * New task briefs put aside with "Save as draft", per workspace, under the
 * app's data for that workspace — never in the project tree. One file, newest
 * first, rewritten whole under a per-workspace queue.
 */
const FILENAME = 'drafts.json'

type DraftsFile = { version: 1; drafts: TaskDraft[] }

const chains = new Map<string, Promise<unknown>>()

function draftsPath(workspacePath: string): string {
  return join(workspaceMetaDir(workspaceId(canonicalizeWorkspacePath(workspacePath))), FILENAME)
}

async function readDrafts(workspacePath: string): Promise<TaskDraft[]> {
  try {
    const raw = JSON.parse(await readFile(draftsPath(workspacePath), 'utf8')) as Partial<DraftsFile>
    const drafts: TaskDraft[] = []
    for (const value of Array.isArray(raw?.drafts) ? raw.drafts : []) {
      const parsed = TaskDraftSchema.safeParse(value)
      if (parsed.success) drafts.push(parsed.data)
    }
    return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      logger.warn('Failed to read task drafts', { scope: 'drafts', err })
    }
    return []
  }
}

/** Serialize read-modify-write per workspace so two saves never drop one. */
function queued<T>(workspacePath: string, work: () => Promise<T>): Promise<T> {
  const key = canonicalizeWorkspacePath(workspacePath)
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(work)
  chains.set(key, next)
  return next
}

async function writeDrafts(workspacePath: string, drafts: TaskDraft[]): Promise<void> {
  const file: DraftsFile = { version: 1, drafts: drafts.slice(0, TASK_DRAFTS_MAX) }
  await atomicWriteJsonAsync(draftsPath(workspacePath), file)
}

export function listTaskDrafts(workspacePath: string): Promise<TaskDraft[]> {
  return queued(workspacePath, () => readDrafts(workspacePath))
}

/** Save a new draft, or update the one named by `id` (a missing id saves a new one). */
export function saveTaskDraft(req: TaskDraftSaveRequest, now = new Date()): Promise<TaskDraft> {
  return queued(req.workspacePath, async () => {
    const drafts = await readDrafts(req.workspacePath)
    const at = now.toISOString()
    const existing = req.id ? drafts.find((d) => d.id === req.id) : undefined
    const hasAttachments =
      req.attachments != null &&
      (req.attachments.images.length > 0 ||
        req.attachments.files.length > 0 ||
        req.attachments.nativeFiles.length > 0 ||
        req.attachments.audio.length > 0)
    const draft = TaskDraftSchema.parse({
      id: existing?.id ?? randomUUID(),
      brief: req.brief,
      doneWhen: req.doneWhen,
      ...(hasAttachments ? { attachments: req.attachments } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at
    })
    await writeDrafts(req.workspacePath, [draft, ...drafts.filter((d) => d.id !== draft.id)])
    return draft
  })
}

/** Remove a draft; true when there was one to remove. */
export function deleteTaskDraft(workspacePath: string, id: string): Promise<boolean> {
  return queued(workspacePath, async () => {
    const drafts = await readDrafts(workspacePath)
    const rest = drafts.filter((d) => d.id !== id)
    if (rest.length === drafts.length) return false
    await writeDrafts(workspacePath, rest)
    return true
  })
}
