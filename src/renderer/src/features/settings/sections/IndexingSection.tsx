import { useCallback, useEffect, useState } from 'react'
import type { CodeIndexRuntimeStatus, WorkspaceAgentContextResult } from '@shared/ipc'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { ProgressBar } from '../components/ProgressBar'
import { SettingsGroup, SettingsItem, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'
import { workspaceShort } from '../utils/settingsHelpers'

type IndexFacts = WorkspaceAgentContextResult['codeIndex']

/**
 * The one live index status. It speaks only for the workspace it names; the
 * rest answer from their own index on disk.
 */
function useCodeIndexRuntime(enabled: boolean): {
  runtime: CodeIndexRuntimeStatus | null
  statusError: string | null
  refresh: () => void
} {
  const [runtime, setRuntime] = useState<CodeIndexRuntimeStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.vyotiq.codeIndexStatus().then((res) => {
      if (res.ok) {
        const { settings: _s, ...rest } = res.data
        setRuntime(rest)
        setStatusError(null)
      } else {
        setStatusError(res.error ?? 'Failed to load index status')
      }
    })
  }, [])

  useEffect(() => {
    refresh()
    const unsub =
      typeof window.vyotiq.onCodeIndexStatus === 'function'
        ? window.vyotiq.onCodeIndexStatus((status) => {
            setRuntime(status)
            setStatusError(null)
          })
        : undefined
    // Poll only while visible; a hidden settings window must not keep IPC awake.
    const poll = (): void => {
      if (document.visibilityState === 'hidden') return
      refresh()
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') refresh()
    }
    // Fast fallback poll only when push subscription is unavailable.
    const id = unsub == null ? window.setInterval(poll, 1000) : window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsub?.()
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, enabled])

  return { runtime, statusError, refresh }
}

/**
 * Each open workspace's own index — file count and last pass — read once and
 * kept current by main's push. Reading it arms that push until the workspace
 * is removed, which the navigator already does for every open workspace.
 */
function useIndexFacts(paths: readonly string[], enabled: boolean): {
  facts: Record<string, IndexFacts>
  reload: (path: string) => void
} {
  const [facts, setFacts] = useState<Record<string, IndexFacts>>({})
  const pathsKey = paths.join('\n')

  const reload = useCallback((path: string) => {
    void window.vyotiq
      .agentContext?.({ workspacePath: path })
      .then((res) => {
        if (res.ok) setFacts((prev) => ({ ...prev, [path]: res.data.codeIndex }))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const list = pathsKey ? pathsKey.split('\n') : []
    const off = window.vyotiq.onAgentContextChanged?.((payload) => {
      const path = list.find((candidate) => workspacePathsEqual(candidate, payload.workspacePath))
      if (path) setFacts((prev) => ({ ...prev, [path]: payload.context.codeIndex }))
    })
    for (const path of list) reload(path)
    return () => off?.()
  }, [pathsKey, enabled, reload])

  return { facts, reload }
}

/** What the index is doing right now, in the words of the stage it reports. */
function syncHint(runtime: CodeIndexRuntimeStatus): string {
  const ip = runtime.indexProgress
  if (!ip) return runtime.message ?? 'Indexing'
  switch (ip.stage) {
    case 'walking':
      return 'Listing files'
    case 'scanning': {
      const counts = `Scanning · ${ip.filesDone.toLocaleString()} of ${ip.filesTotal.toLocaleString()}`
      return ip.currentPath ? `${counts} · ${ip.currentPath}` : counts
    }
    case 'reconciling':
      return 'Reconciling'
    case 'done':
      return 'Finishing'
  }
}

function factsHint(facts: IndexFacts | undefined): string | undefined {
  if (!facts || facts.files == null) return undefined
  const files = `${facts.files.toLocaleString()} ${facts.files === 1 ? 'file' : 'files'}`
  const age = facts.indexedAt ? relativeTimeAgo(facts.indexedAt) : ''
  return age ? `${files} · updated ${age}` : files
}

export function IndexingSection({
  form,
  openWorkspaces = []
}: {
  form: SettingsFormState
  openWorkspaces?: string[]
}) {
  const codeIndex = form.settings.codeIndex ?? { enabled: true }
  const { runtime, statusError, refresh } = useCodeIndexRuntime(codeIndex.enabled)
  const { facts, reload } = useIndexFacts(openWorkspaces, codeIndex.enabled)
  const [reindexing, setReindexing] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ path: string; message: string } | null>(null)

  const syncingPath =
    runtime?.phase === 'syncing' && runtime.workspacePath
      ? (openWorkspaces.find((path) => workspacePathsEqual(path, runtime.workspacePath!)) ?? null)
      : null

  const reindex = (path: string): void => {
    setReindexing(path)
    setRowError(null)
    void window.vyotiq
      .codeIndexReindex({ workspacePath: path })
      .then((res) => {
        if (!res.ok) setRowError({ path, message: res.error ?? 'Reindex failed' })
      })
      .catch((err: unknown) => {
        setRowError({ path, message: err instanceof Error ? err.message : 'Reindex failed' })
      })
      .finally(() => {
        setReindexing(null)
        reload(path)
        refresh()
      })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Index">
        <SwitchField
          id="codeindex-enabled"
          title="Codebase index"
          help="Powers codebase_search (a keyword index) and concept_search (a small embedding model, downloaded once and shared by every workspace). Both run locally; the index lives in app data, not in your project."
          checked={codeIndex.enabled}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('codeIndex', 'enabled')}
          below={
            statusError ? (
              <p className="m-0 text-xs text-danger" role="alert">
                {statusError}
              </p>
            ) : null
          }
          onChange={(enabled) => {
            void form.runUpdate({ codeIndex: { ...codeIndex, enabled } })
          }}
        />
        {codeIndex.enabled && openWorkspaces.length === 0 ? (
          <p className="m-0 py-3 text-xs text-muted">No workspaces open.</p>
        ) : null}
        {codeIndex.enabled
          ? openWorkspaces.map((path) => {
              const own = facts[path]
              const syncing = syncingPath === path
              const building = syncing || own?.state === 'building'
              // The live status names the workspace its error belongs to.
              const failed =
                !building &&
                (own?.state === 'degraded' ||
                  (runtime?.phase === 'error' &&
                    runtime.workspacePath != null &&
                    workspacePathsEqual(runtime.workspacePath, path)))
              const runtimeError =
                failed && runtime?.error && runtime.workspacePath && workspacePathsEqual(runtime.workspacePath, path)
                  ? runtime.error
                  : null
              const error = rowError?.path === path ? rowError.message : runtimeError
              const ready = !building && !failed && own?.state === 'ready'
              const busy = reindexing === path
              const action = busy ? 'Reindexing…' : own?.files ? 'Reindex' : 'Index now'
              return (
                <SettingsItem
                  key={path}
                  id={`index:${path}`}
                  title={workspaceShort(path)}
                  hint={syncing && runtime ? syncHint(runtime) : building ? 'Indexing' : factsHint(own)}
                  below={
                    syncing || error ? (
                      <div className="flex flex-col gap-1.5">
                        {syncing && runtime ? (
                          <ProgressBar
                            percent={runtime.progress != null ? runtime.progress * 100 : null}
                            label={`Indexing ${workspaceShort(path)}`}
                          />
                        ) : null}
                        {error ? (
                          <p className="m-0 text-xs text-danger" role="alert">
                            {error}
                          </p>
                        ) : null}
                      </div>
                    ) : null
                  }
                >
                  <div className="flex items-center gap-3">
                    {ready ? <span className="text-xs text-success">Ready</span> : null}
                    {failed ? <span className="text-xs text-danger">Error</span> : null}
                    {!own ? null : !building && !failed && !ready ? (
                      <span className="text-xs text-tertiary">Not indexed</span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${action} ${workspaceShort(path)}`}
                      pending={busy}
                      disabled={form.formLocked || building || (reindexing != null && !busy)}
                      onClick={() => reindex(path)}
                    >
                      {action}
                    </Button>
                  </div>
                </SettingsItem>
              )
            })
          : null}
      </SettingsGroup>
    </SettingsStack>
  )
}
