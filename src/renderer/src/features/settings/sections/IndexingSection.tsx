import { useCallback, useEffect, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { CodeIndexRuntimeStatus, ProcessMetricsSnapshot } from '@shared/ipc'
import { Button, Switch } from '@renderer/lib/ui'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

function phaseLabel(status: CodeIndexRuntimeStatus | null): string {
  if (!status) return 'Unknown'
  switch (status.phase) {
    case 'ready':
      return 'Ready'
    case 'syncing': {
      const ip = status.indexProgress
      if (ip) return `Code index · ${ip.stage}`
      const pct =
        status.progress != null ? ` · ${Math.round(status.progress * 100)}%` : ''
      return status.message ?? `Syncing${pct}`
    }
    case 'error':
      return `Error${status.error ? `: ${status.error}` : ''}`
    case 'idle':
      return status.message ?? 'Idle'
    default: {
      const _exhaustive: never = status.phase
      return _exhaustive
    }
  }
}

function IndexProgressPanel({ status }: { status: CodeIndexRuntimeStatus | null }) {
  if (!status) return null
  const showBar = status.phase === 'syncing'
  const pct =
    status.progress != null && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null
  const ip = status.indexProgress
  const showDetail = ip != null && status.phase === 'syncing'

  return (
    <div className="flex w-full flex-col gap-1.5">
      <p className="m-0 text-xs text-secondary">{phaseLabel(status)}</p>
      {showBar && pct != null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-sm bg-border"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Index progress"
        >
          <div
            className="h-full bg-accent transition-[width] duration-100 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {showDetail ? (
        <div className="m-0 grid grid-cols-2 gap-x-3 gap-y-0.5 text-caption text-secondary">
          <span>
            {ip.filesDone}/{ip.filesTotal} scanned
          </span>
          <span className="text-right">
            {ip.indexed} updated · {ip.skipped} unchanged
            {ip.removed > 0 ? ` · ${ip.removed} removed` : ''}
          </span>
          <span className="text-right text-muted">
            {ip.indexed + ip.skipped > 0
              ? `${ip.indexed + ip.skipped} text files`
              : '\u00a0'}
          </span>
          {ip.currentPath ? (
            <span className="col-span-2 truncate font-mono text-2xs" title={ip.currentPath}>
              {ip.currentPath}
            </span>
          ) : null}
        </div>
      ) : status.phase === 'syncing' && status.message ? (
        <p className="m-0 text-caption text-secondary">{status.message}</p>
      ) : null}
    </div>
  )
}

function mbForType(snap: ProcessMetricsSnapshot, type: string): number {
  return snap.byType.find((row) => row.type === type)?.workingSetMb ?? 0
}

function processMetricsLabel(snap: ProcessMetricsSnapshot): string {
  return `Main ${mbForType(snap, 'Browser')} MB · GPU ${mbForType(snap, 'GPU')} MB · Tabs ${mbForType(snap, 'Tab')} MB · ${snap.totalWorkingSetMb} MB total`
}

export function IndexingSection({ form }: { form: SettingsFormState }) {
  const codeIndex = form.settings.codeIndex ?? { enabled: true }
  const [runtime, setRuntime] = useState<CodeIndexRuntimeStatus | null>(null)
  const [reindexBusy, setReindexBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [processMetrics, setProcessMetrics] = useState<ProcessMetricsSnapshot | null>(null)

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
    // Fallback poll only when push subscription is unavailable.
    const id = unsub == null ? window.setInterval(poll, 1000) : window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsub?.()
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshStatus, codeIndex.enabled])

  useEffect(() => {
    let cancelled = false
    const pull = (): void => {
      if (typeof window.vyotiq.processMetrics !== 'function') return
      void window.vyotiq.processMetrics().then((res) => {
        if (cancelled || !res.ok) return
        setProcessMetrics(res.data)
      })
    }
    const poll = (): void => {
      if (document.visibilityState === 'hidden') return
      pull()
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') pull()
    }
    pull()
    const id = window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const patchCodeIndex = (partial: Partial<typeof codeIndex>) => {
    void form.runUpdate({
      codeIndex: { ...codeIndex, ...partial }
    })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Codebase indexing">
        <SettingsField
          id="codeindex-enabled"
          title="Enable codebase index"
          hint="Powers codebase_search (ranked keyword retrieval over a local SQLite trigram index)."
          help="Index lives under app userData (not the project tree). Everything runs locally — no models, no downloads, no network."
        >
          <Switch
            size="md"
            checked={codeIndex.enabled}
            disabled={form.formLocked}
            label="Enable codebase index"
            onCheckedChange={(checked) => patchCodeIndex({ enabled: checked })}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Index status">
        <SettingsField
          id="codeindex-status"
          title="Index status"
          hint="Live walk / sync progress for the local code index."
          help="Scanned counts every walked path. Updated / unchanged apply only to text files that are content-hashed. Non-text and oversized files are skipped without those counters."
          wide
        >
          <div className="flex flex-col items-start gap-2">
            <IndexProgressPanel status={runtime} />
            {runtime?.error ? (
              <p className="m-0 w-full text-xs text-danger" role="alert">
                {runtime.error}
              </p>
            ) : null}
            {statusError ? (
              <p className="m-0 w-full text-xs text-danger" role="alert">
                {statusError}
              </p>
            ) : null}
            <Button
              type="button"
              variant="subtle"
              disabled={form.formLocked || reindexBusy || !codeIndex.enabled}
              onClick={() => {
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
              }}
            >
              {reindexBusy ? 'Reindexing…' : 'Reindex workspace'}
            </Button>
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Process memory">
        <SettingsField
          id="process-metrics"
          title="Live processes"
          hint="Chromium working set across the app's processes. Matches Task Manager's combined Electron RSS."
          help="Main is the Browser process. Tabs include the app renderer and any DevTools or agent-browser views."
          wide
        >
          <p className="m-0 text-xs text-secondary">
            {processMetrics ? processMetricsLabel(processMetrics) : 'Sampling…'}
          </p>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
