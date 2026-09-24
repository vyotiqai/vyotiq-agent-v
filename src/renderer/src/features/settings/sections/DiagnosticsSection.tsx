import { useEffect, useState } from 'react'
import type { CrashSnippet, ProcessMetricsSnapshot } from '@shared/ipc'
import { Button, StatusGlyph } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

function mbForType(snap: ProcessMetricsSnapshot, type: string): number {
  return snap.byType.find((row) => row.type === type)?.workingSetMb ?? 0
}

/** "Renderer · oom", "GPU (Network Service) · crashed". */
function crashTitle(snippet: CrashSnippet): string {
  const process =
    snippet.kind === 'renderer'
      ? 'Renderer'
      : snippet.processType
        ? snippet.processType.charAt(0).toUpperCase() + snippet.processType.slice(1)
        : 'Child process'
  return `${process}${snippet.name ? ` (${snippet.name})` : ''} · ${snippet.reason}`
}

/** "22 Sep 18:04 · exit 1". */
function crashDetail(snippet: CrashSnippet): string {
  const at = new Date(snippet.at)
  return [
    Number.isNaN(at.getTime())
      ? snippet.at
      : at.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
    snippet.exitCodeHex ?? (snippet.exitCode != null ? `exit ${snippet.exitCode}` : null)
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Samples process memory while the section is visible; hidden windows stay idle. */
function useProcessMetrics(): ProcessMetricsSnapshot | null {
  const [metrics, setMetrics] = useState<ProcessMetricsSnapshot | null>(null)
  useEffect(() => {
    let cancelled = false
    const pull = (): void => {
      if (typeof window.vyotiq?.processMetrics !== 'function') return
      void window.vyotiq.processMetrics().then((res) => {
        if (!cancelled && res.ok) setMetrics(res.data)
      })
    }
    const poll = (): void => {
      if (document.visibilityState !== 'hidden') pull()
    }
    pull()
    const id = window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', poll)
    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [])
  return metrics
}

export function DiagnosticsSection({ form }: { form: SettingsFormState }) {
  const [dsnConfigured, setDsnConfigured] = useState(false)
  const [logsPath, setLogsPath] = useState<string | null>(null)
  const [crashes, setCrashes] = useState<CrashSnippet[]>([])
  const [openingLogs, setOpeningLogs] = useState(false)
  const [traceDumping, setTraceDumping] = useState(false)
  const metrics = useProcessMetrics()

  useEffect(() => {
    let cancelled = false
    const buildDsn = Boolean(import.meta.env.VITE_SENTRY_DSN?.trim())
    void (async () => {
      if (window.vyotiq?.telemetryStatus) {
        const res = await window.vyotiq.telemetryStatus()
        if (!cancelled) setDsnConfigured(res.ok ? res.data.dsnConfigured : buildDsn)
      } else if (!cancelled) {
        setDsnConfigured(buildDsn)
      }
      if (window.vyotiq?.getLogsPath) {
        const res = await window.vyotiq.getLogsPath()
        if (!cancelled && res.ok) setLogsPath(res.data)
      }
      if (window.vyotiq?.getCrashDiagnostics) {
        const res = await window.vyotiq.getCrashDiagnostics()
        if (!cancelled && res.ok) setCrashes(res.data.snippets)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const reportFailure = (err: unknown): void => {
    form.setErrorMessage(err instanceof Error ? err.message : String(err))
  }

  const openLogs = (): void => {
    form.clearErrors()
    setOpeningLogs(true)
    void (window.vyotiq?.openLogsDir?.() ?? Promise.reject(new Error('Logs API unavailable')))
      .then((res) => {
        if (!res.ok) form.setErrorMessage(res.error)
      })
      .catch(reportFailure)
      .finally(() => setOpeningLogs(false))
  }

  const dumpTrace = (): void => {
    form.clearErrors()
    setTraceDumping(true)
    void (window.vyotiq?.stopTrace?.() ?? Promise.reject(new Error('Trace API unavailable')))
      .then((res) => {
        if (res.ok) void window.vyotiq?.openLogsDir?.()
        else form.setErrorMessage(res.error)
      })
      .catch(reportFailure)
      .finally(() => setTraceDumping(false))
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Privacy">
        <SwitchField
          id="telemetry"
          title="Share crash and error reports"
          hint={
            dsnConfigured
              ? 'Off by default. Local logs are written either way.'
              : 'Not available in this build. Local logs are written either way.'
          }
          help="Reports never include chat contents, API keys, or file bodies. Needs a Sentry DSN at build time."
          checked={dsnConfigured && form.settings.telemetryEnabled}
          disabled={!dsnConfigured || form.formLocked}
          {...(dsnConfigured ? form.defaultMark('telemetryEnabled') : {})}
          onChange={(telemetryEnabled) => {
            void form.runUpdate({ telemetryEnabled })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Troubleshooting">
        <SettingsField
          id="logs"
          title="Logs"
          hint={logsPath ?? 'Rotating logs, always written locally.'}
          help="Written regardless of crash reporting. Often the only signal when a crash dump is empty."
        >
          <Button
            size="sm"
            variant="secondary"
            icon="folderOpen"
            pending={openingLogs}
            disabled={form.formLocked}
            onClick={openLogs}
          >
            {openingLogs ? 'Opening…' : 'Open folder'}
          </Button>
        </SettingsField>
        <SettingsField
          id="trace-capture"
          title="Trace capture"
          hint="Always recording the last few minutes; saved on its own after a crash or hang."
          help="Near-zero cost in the background. Saving writes the last few minutes to the traces folder as chrome://tracing JSON, then opens the folder."
        >
          <Button size="sm" variant="secondary" pending={traceDumping} disabled={form.formLocked} onClick={dumpTrace}>
            {traceDumping ? 'Saving…' : 'Save trace now'}
          </Button>
        </SettingsField>
        {/* The total is the answer; the split is the detail under it. */}
        <SettingsField
          id="process-metrics"
          title="Memory"
          hint={
            metrics
              ? `Main ${mbForType(metrics, 'Browser')} MB · GPU ${mbForType(metrics, 'GPU')} MB · Tabs ${mbForType(metrics, 'Tab')} MB`
              : 'Working set across the app’s processes.'
          }
          help="Working set across all of the app's processes, as Task Manager counts it. Main is the browser process; Tabs include the app window, DevTools, and the agent's browser views."
        >
          <span className="font-mono text-xs text-fg tnum">
            {metrics ? `${metrics.totalWorkingSetMb} MB` : 'Sampling…'}
          </span>
        </SettingsField>
        <SettingsField
          id="recent-crashes"
          title="Recent crashes"
          hint={crashes.length === 0 ? 'None recorded on this install.' : undefined}
          help="Renderer, GPU, and utility process exits. Crashpad dumps are often empty for these exits — this list and the logs are the useful signal."
          below={
            crashes.length > 0 ? (
              <ul className="m-0 flex max-h-48 list-none flex-col gap-1.5 overflow-auto p-0">
                {crashes.map((snippet, i) => (
                  <li key={`${snippet.at}-${snippet.kind}-${i}`} className="flex min-w-0 items-center gap-2 text-xs">
                    <StatusGlyph state="failed" size={13} />
                    <span className="min-w-0 truncate text-fg">{crashTitle(snippet)}</span>
                    <span className="shrink-0 font-mono text-tertiary tnum">{crashDetail(snippet)}</span>
                  </li>
                ))}
              </ul>
            ) : null
          }
        />
      </SettingsGroup>
    </SettingsStack>
  )
}
