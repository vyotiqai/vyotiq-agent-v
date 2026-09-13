import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../../src/shared/ipc/schemas/settings'
import { workspaceIdFromPath } from '../../../src/shared/utils/workspaceId'
import { canonicalizeWorkspacePath } from '../../../src/shared/utils/workspacePath'
import { RUN_INTERRUPTED_ERROR } from '../../../src/shared/runInterrupt'

export type SeededRun = {
  runId: string
  goal: string
  updatedAt?: string
}

export type SeededInterruptedRun = SeededRun & {
  status: 'running' | 'cancelled'
  resumable?: true
  error?: string
  step?: number
}

/**
 * Canonical form the app itself stores: addWorkspace realpath-resolves the
 * root before canonicalizing (workspaces.ts), so seeds must derive the
 * workspace ID from the same resolution — otherwise seeded runs land under
 * a different workspace ID than listRuns looks up (mac /var → /private/var;
 * CI run 33609263586 chatPane.drag listRuns === []).
 */
function appCanonicalWorkspacePath(workspacePath: string): string {
  const resolved = existsSync(workspacePath) ? realpathSync(workspacePath) : workspacePath
  return canonicalizeWorkspacePath(resolved)
}

/** Write run status files into the Electron userData sessions tree. */
export function seedRunsInUserData(
  userDataDir: string,
  workspacePath: string,
  runs: SeededRun[]
): void {
  const canonical = appCanonicalWorkspacePath(workspacePath)
  const id = workspaceIdFromPath(canonical)
  const sessionsRoot = join(userDataDir, 'workspaces', id, 'sessions')
  mkdirSync(sessionsRoot, { recursive: true })
  for (const [index, run] of runs.entries()) {
    const dir = join(sessionsRoot, run.runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify(
        {
          status: 'done',
          step: 0,
          updatedAt: run.updatedAt ?? `2026-08-08T00:00:${String(index).padStart(2, '0')}.000Z`,
          goal: run.goal,
          workspacePath: canonical
        },
        null,
        2
      ),
      'utf8'
    )
    writeFileSync(
      join(dir, 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: run.goal })}\n`,
      'utf8'
    )
  }
}

/** Seed a run that may be running or interrupted (cancelled + resumable). */
export function seedInterruptedRun(
  userDataDir: string,
  workspacePath: string,
  run: SeededInterruptedRun
): void {
  const canonical = appCanonicalWorkspacePath(workspacePath)
  const id = workspaceIdFromPath(canonical)
  const dir = join(userDataDir, 'workspaces', id, 'sessions', run.runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify(
      {
        status: run.status,
        step: run.step ?? 0,
        updatedAt: run.updatedAt ?? new Date().toISOString(),
        goal: run.goal,
        workspacePath: canonical,
        ...(run.resumable ? { resumable: true } : {}),
        ...(run.error ? { error: run.error } : {})
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(dir, 'messages.jsonl'),
    `${JSON.stringify({ role: 'user', content: run.goal })}\n`,
    'utf8'
  )
}

/** Write workspaces.json so the app opens with a workspace and active run on boot. */
export function seedWorkspacesRegistry(
  userDataDir: string,
  workspacePath: string,
  activeRunId: string | null
): void {
  const canonical = appCanonicalWorkspacePath(workspacePath)
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(
    join(userDataDir, 'workspaces.json'),
    JSON.stringify(
      {
        version: 2,
        legacySessionsMigrated: true,
        openPaths: [canonical],
        activePath: canonical,
        recentPaths: [canonical],
        uiStateByPath: {
          [canonical]: {
            activeRunId,
            openRunIds: activeRunId ? [activeRunId] : [],
            scrollTop: 0,
            scrollTopByRunId: {},
            composerDraft: '',
            composerDraftByRunId: {},
            agentMode: 'agent'
          }
        },
        settingsOverridesByPath: {}
      },
      null,
      2
    ),
    'utf8'
  )
}

/** Seed settings.json (merged over defaults). */
export function seedAppSettings(
  userDataDir: string,
  partial: Record<string, unknown> = {}
): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ ...DEFAULT_SETTINGS, ...partial }, null, 2),
    'utf8'
  )
}

export { RUN_INTERRUPTED_ERROR }
