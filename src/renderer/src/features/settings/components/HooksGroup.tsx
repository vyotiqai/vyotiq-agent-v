import { useCallback, useEffect, useState, type JSX } from 'react'
import type { HookRunLogEntry, HooksFileView, HooksOverview } from '@shared/ipc'
import { Button, IconButton, pushToast } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { SettingsField, SettingsGroup } from './SettingsField'

/** Runs listed before "Show all". */
const RUNS_SHOWN = 8

function fileHint(file: HooksFileView): string {
  if (!file.exists) return 'No file yet.'
  if (file.error) return file.error
  if (file.commands.length === 0) return 'The file is there with no hooks in it.'
  return `${file.commands.length} hook${file.commands.length === 1 ? '' : 's'}.`
}

const DECISION_WORDS: Record<NonNullable<HooksOverview['workspaceDecision']>, string> = {
  allow: 'Allowed: its hooks run.',
  deny: 'Denied: its hooks never run.',
  changed: 'Changed since you decided: the next task asks again.',
  none: 'Not decided: the next task asks before running them.'
}

function runOutcome(run: HookRunLogEntry): string {
  if (run.timedOut) return 'timed out'
  if (run.code === 0) return 'ok'
  if (run.code === 2) return 'blocked'
  return run.code === null ? 'failed to start' : `exit ${run.code}`
}

function CommandList({ commands }: { commands: string[] }): JSX.Element | null {
  if (commands.length === 0) return null
  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {commands.map((command, i) => (
        <li key={`${i}-${command}`} className="truncate font-mono text-caption text-muted" title={command}>
          {command}
        </li>
      ))}
    </ul>
  )
}

/**
 * Hooks in Settings: your file and this workspace's, what each would run,
 * whether the workspace's is allowed, every remembered decision, and what
 * ran lately. Editing stays in your editor; Open file writes an empty file
 * when there is none.
 */
export function HooksGroup({ workspacePath }: { workspacePath: string | null }): JSX.Element {
  const [overview, setOverview] = useState<HooksOverview | null>(null)
  const [allRuns, setAllRuns] = useState(false)

  const load = useCallback(async () => {
    const res = await window.vyotiq?.hooksOverview?.(workspacePath ? { workspacePath } : {})
    if (res?.ok) setOverview(res.data)
  }, [workspacePath])
  useEffect(() => {
    void load()
  }, [load])

  const open = async (scope: 'user' | 'workspace'): Promise<void> => {
    const res = await window.vyotiq.hooksOpenFile({ scope, ...(workspacePath ? { workspacePath } : {}) })
    if (!res.ok) pushToast(res.error, 'error')
    void load()
  }
  const decide = async (decision: 'allow' | 'deny' | 'forget'): Promise<void> => {
    if (!workspacePath) return
    const res = await window.vyotiq.hooksDecide({ workspacePath, decision })
    if (!res.ok) pushToast(res.error, 'error')
    void load()
  }
  const forget = async (workspace: string): Promise<void> => {
    const res = await window.vyotiq.hooksForget(workspace)
    if (!res.ok) pushToast(res.error, 'error')
    void load()
  }

  const runs = overview?.runs ?? []
  const shownRuns = allRuns ? runs : runs.slice(0, RUNS_SHOWN)
  const ws = overview?.workspace ?? null
  const decision = overview?.workspaceDecision ?? null

  return (
    <SettingsGroup title="Hooks">
      <SettingsField
        id="hooks-user"
        title="Your hooks"
        hint={overview ? fileHint(overview.user) : 'Reading…'}
        help="Commands of yours around the agent's work, in Claude Code's hooks.json shape. Yours always run, in every workspace."
        below={overview ? <CommandList commands={overview.user.commands} /> : null}
      >
        <Button size="sm" variant="secondary" onClick={() => void open('user')}>
          {overview?.user.exists ? 'Open file' : 'Create file'}
        </Button>
      </SettingsField>
      {workspacePath ? (
        <SettingsField
          id="hooks-workspace"
          title={`${formatWorkspaceName(workspacePath)}'s hooks`}
          hint={ws && ws.exists && !ws.error && decision ? DECISION_WORDS[decision] : ws ? fileHint(ws) : 'Reading…'}
          help="From .vyotiq/hooks.json in the workspace. They came with the folder, so they run only once you allow that exact file; any change to it asks again."
          below={ws ? <CommandList commands={ws.commands} /> : null}
        >
          <div className="flex items-center gap-1.5">
            {ws && ws.exists && !ws.error && ws.commands.length > 0 ? (
              decision === 'allow' ? (
                <Button size="sm" variant="ghost" onClick={() => void decide('deny')}>
                  Deny
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => void decide('allow')}>
                  Allow
                </Button>
              )
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => void open('workspace')}>
              {ws?.exists ? 'Open file' : 'Create file'}
            </Button>
          </div>
        </SettingsField>
      ) : null}
      {overview && overview.trust.length > 0 ? (
        <SettingsField
          id="hooks-decisions"
          title="Remembered decisions"
          hint="Workspaces whose hooks file you allowed or denied. Forget one to be asked again."
          below={
            <ul className="m-0 list-none divide-y divide-border/60 p-0" data-hooks-trust>
              {overview.trust.map((entry) => (
                <li key={entry.workspace} className="flex h-8 min-w-0 items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg" title={entry.workspace}>
                    {entry.workspace}
                  </span>
                  <span className="shrink-0 text-tertiary">{entry.decision === 'allow' ? 'Allowed' : 'Denied'}</span>
                  <IconButton icon="close" label={`Forget the decision for ${entry.workspace}`} size="xs" tone="muted" onClick={() => void forget(entry.workspace)} />
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      <SettingsField
        id="hooks-runs"
        title="Recent runs"
        hint={runs.length === 0 ? 'No hook has run since the app started.' : `${runs.length} since the app started, newest first.`}
        below={
          runs.length > 0 ? (
            <div>
              <ul className="m-0 list-none divide-y divide-border/60 p-0" data-hooks-runs>
                {shownRuns.map((run, i) => (
                  <li key={`${run.at}-${i}`} className="flex h-8 min-w-0 items-center gap-2 text-xs" title={run.stderr || undefined}>
                    <span className="w-28 shrink-0 truncate text-muted">{run.event}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg">{run.command}</span>
                    <span className={run.code === 0 ? 'shrink-0 text-tertiary' : 'shrink-0 text-warning'}>{runOutcome(run)}</span>
                    <span className="w-14 shrink-0 text-right font-mono text-caption tabular-nums text-tertiary">{run.ms} ms</span>
                  </li>
                ))}
              </ul>
              {runs.length > RUNS_SHOWN ? (
                <Button size="xs" variant="ghost" onClick={() => setAllRuns((v) => !v)}>
                  {allRuns ? 'Show fewer' : `Show all ${runs.length}`}
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        <IconButton icon="refresh" label="Read hooks again" size="xs" tone="muted" onClick={() => void load()} />
      </SettingsField>
    </SettingsGroup>
  )
}
