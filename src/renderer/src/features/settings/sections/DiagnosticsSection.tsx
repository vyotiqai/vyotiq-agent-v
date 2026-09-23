import { useEffect, useState } from 'react'
import type { CrashSnippet, ProcessMetricsSnapshot } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

function mbForType(snap: ProcessMetricsSnapshot, type: string): number {
  return snap.byType.find((row) => row.type === type)?.workingSetMb ?? 0
}

function crashDetail(snippet: CrashSnippet): string {
  return [
    new Date(snippet.at).toLocaleString(),
    snippet.exitCodeHex ?? (snippet.exitCode != null ? `exit ${snippet.exitCode}` : null),
    snippet.processType ?? null,
    snippet.name ?? null
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
          title="Share crash & error reports"
          label="Share crash and error reports"
          hint={
            dsnConfigured
              ? 'Off by default. Local logs are written either way.'
              : 'Not available in this build.'
          }
          help="Reports never include chat contents, API keys, or file bodies. Needs a Sentry DSN at build time."
          checked={dsnConfigured && form.settings.telemetryEnabled}
          disabled={!dsnConfigured || form.formLocked}
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
          <Button variant="subtle" pending={openingLogs} disabled={form.formLocked} onClick={openLogs}>
            {openingLogs ? 'Opening…' : 'Open logs folder'}
          </Button>
        </SettingsField>
        <SettingsField
          id="trace-capture"
          title="Trace capture"
          hint="Always recording; saved automatically on a crash or hang."
          help="Near-zero cost in the background. Dump now saves the last few minutes to the traces folder as chrome://tracing JSON."
        >
          <Button
            variant="subtle"
            pending={traceDumping}
            disabled={form.formLocked}
            onClick={dumpTrace}
          >
            {traceDumping ? 'Dumping…' : 'Dump trace now'}
          </Button>
        </SettingsField>
        <SettingsField
          id="recent-crashes"
          title="Recent crashes"
          hint={crashes.length === 0 ? 'None recorded on this install.' : 'Renderer, GPU, and utility process exits.'}
          help="Crashpad dumps are often empty for these exits — this list and the logs are the useful signal."
          wide={crashes.length > 0}
        >
          {crashes.length > 0 ? (
            <ul className="m-0 flex max-h-48 list-none flex-col divide-y divide-border/40 overflow-auto p-0">
              {crashes.map((snippet, i) => (
                <li key={`${snippet.at}-${snippet.kind}-${i}`} className="flex flex-col py-1.5 text-caption">
                  <span className="text-fg">
                    {snippet.kind === 'renderer' ? 'Renderer' : 'Child process'} · {snippet.reason}
                  </span>
                  <span className="text-muted">{crashDetail(snippet)}</span>
                </li>
              ))}
            </ul>
          ) : null}
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
          <p className="m-0 text-sm tabular-nums text-fg">
            {metrics ? `${metrics.totalWorkingSetMb} MB` : 'Sampling…'}
          </p>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
