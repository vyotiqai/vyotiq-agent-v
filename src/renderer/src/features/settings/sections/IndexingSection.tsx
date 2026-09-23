import { useCallback, useEffect, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { CodeIndexRuntimeStatus } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import { ProgressBar } from '../components/ProgressBar'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

function phaseLabel(status: CodeIndexRuntimeStatus | null): string {
  if (!status) return 'Checking…'
  switch (status.phase) {
    case 'ready':
      return status.message ?? 'Ready'
    case 'syncing': {
      const ip = status.indexProgress
      if (ip) return `Indexing · ${ip.stage}`
      const pct = status.progress != null ? ` · ${Math.round(status.progress * 100)}%` : ''
      return status.message ?? `Syncing${pct}`
    }
    case 'error':
      return 'Error'
    case 'idle':
      return status.message ?? 'Idle'
    default: {
      const _exhaustive: never = status.phase
      return _exhaustive
    }
  }
}

function IndexProgress({ status }: { status: CodeIndexRuntimeStatus }) {
  if (status.phase !== 'syncing') return null
  const ip = status.indexProgress
  return (
    <div className="flex w-full flex-col gap-1.5">
      <ProgressBar
        percent={status.progress != null ? status.progress * 100 : null}
        label="Index progress"
      />
      {ip ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-caption text-secondary">
          <span className="tabular-nums">
            {ip.filesDone}/{ip.filesTotal} scanned
          </span>
          <span className="text-right tabular-nums">
            {ip.indexed} updated · {ip.skipped} unchanged
            {ip.removed > 0 ? ` · ${ip.removed} removed` : ''}
          </span>
          {ip.currentPath ? (
            <span className="col-span-2 truncate font-mono text-2xs text-muted" title={ip.currentPath}>
              {ip.currentPath}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function IndexingSection({ form }: { form: SettingsFormState }) {
  const codeIndex = form.settings.codeIndex ?? { enabled: true }
  const [runtime, setRuntime] = useState<CodeIndexRuntimeStatus | null>(null)
  const [reindexBusy, setReindexBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)

  const refreshStatus = useCallback(() => {
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
    refreshStatus()
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
      refreshStatus()
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') refreshStatus()
    }
    // Fast fallback poll only when push subscription is unavailable.
    const id = unsub == null ? window.setInterval(poll, 1000) : window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsub?.()
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshStatus, codeIndex.enabled])

  const reindex = (): void => {
    setReindexBusy(true)
    setStatusError(null)
    void window.vyotiq
      .codeIndexReindex()
      .then((res) => {
        if (!res.ok) {
          setStatusError(res.error ?? 'Reindex failed')
          return
        }
        refreshStatus()
      })
      .finally(() => setReindexBusy(false))
  }

  const error = statusError ?? runtime?.error ?? null
  const syncing = codeIndex.enabled && runtime?.phase === 'syncing'

  return (
    <SettingsStack>
      <SettingsGroup title="Code index">
        <SwitchField
          id="codeindex-enabled"
          title="Enable codebase index"
          hint="Lets the agent search the workspace by keyword and by meaning."
          help="Powers codebase_search (a keyword index) and concept_search (a small embedding model, downloaded once and shared by every workspace). Both run locally; the index lives in app data, not in your project."
          checked={codeIndex.enabled}
          disabled={form.formLocked}
          onChange={(enabled) => {
            void form.runUpdate({ codeIndex: { ...codeIndex, enabled } })
          }}
        />
        {/* Same shape as Storage's App data row: the status is the hint, so it
            reads where every other row's answer does, and Reindex holds the
            right edge. Progress and errors go underneath, so a sync starting
            never moves the button. */}
        <SettingsField
          id="codeindex-status"
          title="Index status"
          hint={codeIndex.enabled ? phaseLabel(runtime) : 'Off'}
          help="Scanned counts every walked path. Updated and unchanged count only text files, which are content-hashed; binary and oversized files are skipped."
        >
          <Button
            variant="subtle"
            pending={reindexBusy}
            disabled={form.formLocked || !codeIndex.enabled}
            onClick={reindex}
          >
            {reindexBusy ? 'Reindexing…' : 'Reindex workspace'}
          </Button>
        </SettingsField>
        {syncing || error ? (
          <div className="flex flex-col gap-1.5 px-4 py-3">
            {syncing && runtime ? <IndexProgress status={runtime} /> : null}
            {error ? (
              <p className="m-0 text-xs text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  )
}
