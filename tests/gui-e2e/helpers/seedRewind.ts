import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { seedRunsInUserData, sessionsRootFor } from './seedWorkspace'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

export const REWIND_CHECKPOINT_ID = '1a2b3c4d-0000-4000-8000-00000000c7c7'

export const REWIND_FILES = {
  /** Changed by run 2. */
  changed: { path: 'src/settings/sections.ts', before: 'export const SECTIONS = []\n', after: "export const SECTIONS = ['App']\n" },
  /** Created by run 2. */
  created: { path: 'src/settings/groups.ts', after: "export const GROUPS = ['App', 'Agent', 'System']\n" },
  /** Changed by run 2, then by you. */
  yours: {
    path: 'src/lib/layout.ts',
    before: 'export const GAP = 4\n',
    after: 'export const GAP = 8\n',
    mine: 'export const GAP = 6 // mine\n'
  }
} as const

/**
 * A two-run task whose second run changed, created and changed three files —
 * the last one changed again by you afterwards — with the write checkpoint on
 * disk the way the loop writes it: before-image copies, post-write hashes and
 * the instruction it answered (`anchorUserMessageIndex`).
 */
export function seedRewindTask(userDataDir: string, workspacePath: string, runId: string): void {
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(workspacePath, rel)), { recursive: true })
    writeFileSync(join(workspacePath, rel), text, 'utf8')
  }
  const { changed, created, yours } = REWIND_FILES
  put(changed.path, changed.after)
  put(created.path, created.after)
  put(yours.path, yours.mine)

  seedRunsInUserData(userDataDir, workspacePath, [
    { runId, goal: 'Regroup Settings into App, Agent and System', updatedAt: new Date().toISOString() }
  ])
  const runDir = join(sessionsRootFor(userDataDir, workspacePath), runId)
  const t0 = Date.now() - 10 * 60_000
  const at = (s: number): string => new Date(t0 + s * 1000).toISOString()
  const rows = [
    { role: 'user', at: at(0), content: 'Regroup Settings into App, Agent and System' },
    { role: 'assistant', content: 'Settings now open on three groups.' },
    { role: 'user', at: at(120), content: 'Also move Shortcuts under App, and share one section-label style' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'edit', arguments: JSON.stringify({ path: changed.path, contents: changed.after }) },
        { id: 'c2', name: 'edit', arguments: JSON.stringify({ path: created.path, contents: created.after }) },
        { id: 'c3', name: 'edit', arguments: JSON.stringify({ path: yours.path, contents: yours.after }) }
      ]
    },
    { role: 'tool', toolCallId: 'c1', toolName: 'edit', content: `Wrote ${changed.path}`, ok: true },
    { role: 'tool', toolCallId: 'c2', toolName: 'edit', content: `Created ${created.path}`, ok: true },
    { role: 'tool', toolCallId: 'c3', toolName: 'edit', content: `Wrote ${yours.path}`, ok: true },
    { role: 'assistant', content: 'Shortcuts sit under App, and the section labels share one style.' }
  ]
  writeFileSync(join(runDir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')

  const id = REWIND_CHECKPOINT_ID
  const cpDir = join(runDir, 'checkpoints', id)
  const copy = (rel: string, text: string): void => {
    mkdirSync(dirname(join(cpDir, 'files', rel)), { recursive: true })
    writeFileSync(join(cpDir, 'files', rel), text, 'utf8')
  }
  copy(changed.path, changed.before)
  copy(yours.path, yours.before)
  const createdAt = at(150)
  writeFileSync(
    join(cpDir, 'meta.json'),
    JSON.stringify({
      id,
      createdAt,
      anchorUserMessageIndex: 2,
      files: [
        { path: changed.path, action: 'modified', undoable: true, hash: sha256(changed.after) },
        { path: created.path, action: 'created', undoable: true, hash: sha256(created.after) },
        { path: yours.path, action: 'modified', undoable: true, hash: sha256(yours.after) }
      ]
    }),
    'utf8'
  )
  writeFileSync(join(runDir, 'checkpoints', 'index.json'), JSON.stringify({ checkpoints: [{ id, createdAt }] }), 'utf8')
}
