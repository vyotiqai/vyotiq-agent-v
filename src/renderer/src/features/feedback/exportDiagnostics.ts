export type DiagnosticsExportOutcome =
  | { kind: 'saved'; fileName: string }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string }

/**
 * Settings → Diagnostics and the feedback dialog both save the bundle: main
 * asks where, writes the redacted .zip and shows it in the file manager.
 */
export async function exportDiagnosticsBundle(): Promise<DiagnosticsExportOutcome> {
  const exportDiagnostics = window.vyotiq?.exportDiagnostics
  if (typeof exportDiagnostics !== 'function') return { kind: 'error', message: 'Diagnostics export is unavailable.' }
  try {
    const res = await exportDiagnostics()
    if (!res.ok) return { kind: 'error', message: res.error }
    return res.data.saved ? { kind: 'saved', fileName: res.data.fileName } : { kind: 'canceled' }
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}
