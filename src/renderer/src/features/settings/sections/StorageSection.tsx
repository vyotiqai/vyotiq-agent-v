import { useCallback, useEffect, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type {
  Settings,
  StorageCleanupPreviewResult,
  StorageCleanupRunResult,
  StorageReportResult
} from '@shared/ipc'
import { DEFAULT_STORAGE_SETTINGS } from '@shared/ipc'
import { Button, Switch } from '@renderer/lib/ui'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

type CleanupStage = 'idle' | 'previewing' | 'confirming' | 'running' | 'done'

export function StorageSection({ form }: { form: SettingsFormState }) {
  const settings = form.settings
  const storage = settings.storage ?? DEFAULT_STORAGE_SETTINGS
  const [report, setReport] = useState<StorageReportResult | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [reportBusy, setReportBusy] = useState(false)
  const [cleanupStage, setCleanupStage] = useState<CleanupStage>('idle')
  const [preview, setPreview] = useState<StorageCleanupPreviewResult | null>(null)
  const [runResult, setRunResult] = useState<StorageCleanupRunResult | null>(null)
  const [cleanupError, setCleanupError] = useState<string | null>(null)

  const refreshReport = useCallback(() => {
    if (typeof window.vyotiq?.storageReport !== 'function') return
    setReportBusy(true)
    void window.vyotiq
      .storageReport()
      .then((res) => {
        if (res.ok) {
          setReport(res.data)
          setReportError(null)
        } else {
          setReportError(res.error)
        }
      })
      .finally(() => setReportBusy(false))
  }, [])

  // Live scan on open (wired surface — no fake numbers).
  useEffect(() => {
    refreshReport()
  }, [refreshReport])

  // §8.1 first-run ack: opening the section arms the full retention policy.
  useEffect(() => {
    if (settings.storageSurfaceAcked) return
    if (typeof window.vyotiq?.storageAckSurface !== 'function') return
    void window.vyotiq.storageAckSurface(true)
  }, [settings.storageSurfaceAcked])

  const patchStorage = (partial: Partial<Settings['storage']>) => {
    void form.runUpdate({ storage: { ...storage, ...partial } })
  }

  const startCleanup = (): void => {
    if (typeof window.vyotiq?.storageCleanupPreview !== 'function') return
    setCleanupStage('previewing')
    setCleanupError(null)
    setRunResult(null)
    void window.vyotiq
      .storageCleanupPreview()
      .then((res) => {
        if (res.ok) {
          setPreview(res.data)
          setCleanupStage('confirming')
        } else {
          setCleanupError(res.error)
          setCleanupStage('idle')
        }
      })
      .catch(() => setCleanupStage('idle'))
  }

  const confirmCleanup = (): void => {
    if (!preview) return
    if (typeof window.vyotiq?.storageCleanupRun !== 'function') return
    setCleanupStage('running')
    void window.vyotiq
      .storageCleanupRun({ confirmToken: preview.confirm.token })
      .then((res) => {
        if (res.ok) {
          setRunResult(res.data)
          setCleanupStage('done')
          setPreview(null)
          refreshReport()
        } else {
          setCleanupError(res.error)
          setCleanupStage('idle')
        }
      })
      .catch(() => setCleanupStage('idle'))
  }

  const cancelCleanup = (): void => {
    setPreview(null)
    setCleanupStage('idle')
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Storage usage">
        <SettingsField
          id="storage-usage"
          title="Usage report"
          hint={
            report
              ? `${formatBytes(report.totalBytes)} across app data · managed set ${formatBytes(
                  report.managedBytes
                )} · cap ${formatBytes(report.sizeCapBytes)}${report.overCap ? ' (over cap)' : ''}`
              : 'Live scan of app storage on open.'
          }
          help="Measured live from app userData: checkpoints, transcripts, per-workspace indexes, instance worktrees, traces, logs, dictation models, embedder model, browser partitions, and cache. Numbers refresh on open and after a cleanup."
        >
          <div className="flex items-center gap-2">
            <Button
              variant="subtle"
              disabled={reportBusy}
              onClick={refreshReport}
            >
              {reportBusy ? 'Scanning…' : 'Rescan'}
            </Button>
          </div>
        </SettingsField>

        {report ? (
          <div className="px-4 pb-3" data-settings-field="storage-usage-report">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {report.categories.map((cat) => (
                  <tr key={cat.id} className="border-t border-border/40">
                    <td className="py-1 pr-2 text-fg-strong">{cat.label}</td>
                    <td className="py-1 pr-2 text-right text-secondary">
                      {formatBytes(cat.bytes)}
                    </td>
                    <td className="py-1 text-right text-muted">
                      {cat.files === 1 ? '1 file' : `${cat.files} files`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reportError ? (
              <p className="m-0 mt-2 text-xs text-danger" role="alert">
                {reportError}
              </p>
            ) : null}
          </div>
        ) : null}

        {report && report.categories.length > 0 ? (
          <SettingsField
            id="storage-models-link"
            title="Local models"
            hint="Dictation and embedder models are reported above but managed in their own sections."
            help="Deleting the local dictation model requires a multi-GB re-download — manage it in Settings → Voice. The embedder model is shared by all workspaces (Settings → Indexing)."
          >
            <Button
              variant="subtle"
              onClick={() => form.navigateSection('voice')}
            >
              Open Voice settings
            </Button>
          </SettingsField>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Free up space">
        <SettingsField
          id="storage-free-up"
          title="Free up space"
          hint="Deletes discarded checkpoints, old untracked workspace storage, and old sessions per the policy below. Nothing written in the last 24 hours is ever touched. Requires confirmation."
          help="Preview computes exactly what would be reclaimed per category; nothing is deleted until you confirm. Orphan workspace storage means per-workspace runtime dirs the app no longer tracks (old indexes, sessions, worktrees) — the single biggest measured term."
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {cleanupStage === 'idle' || cleanupStage === 'done' ? (
              <Button variant="subtle" onClick={startCleanup}>
                {cleanupStage === 'done' ? 'Clean again' : 'Free up space'}
              </Button>
            ) : null}
            {cleanupStage === 'previewing' ? (
              <span className="text-xs text-secondary">Previewing…</span>
            ) : null}
            {cleanupStage === 'running' ? (
              <span className="text-xs text-secondary">Cleaning…</span>
            ) : null}
          </div>
        </SettingsField>

        {cleanupStage === 'confirming' && preview ? (
          <div className="px-4 pb-3" data-settings-field="storage-cleanup-preview">
            <p className="m-0 text-xs text-fg-strong">
              Reclaimable: {formatBytes(preview.totalReclaimBytes)}
            </p>
            <ul className="m-0 mt-1 list-none p-0 text-xs text-secondary">
              {preview.categories
                .filter((c) => c.reclaimBytes > 0 || c.items > 0)
                .map((c) => (
                  <li key={c.id} className="flex justify-between gap-3 py-0.5">
                    <span>{c.label}</span>
                    <span>
                      {formatBytes(c.reclaimBytes)}
                      {c.items > 0 ? ` · ${c.items} item${c.items === 1 ? '' : 's'}` : ''}
                    </span>
                  </li>
                ))}
            </ul>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="subtle" onClick={cancelCleanup}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmCleanup}>
                Delete {formatBytes(preview.totalReclaimBytes)}
              </Button>
            </div>
          </div>
        ) : null}

        {cleanupStage === 'done' && runResult ? (
          <div className="px-4 pb-3" data-settings-field="storage-cleanup-result">
            <p className="m-0 text-xs text-fg-strong">
              Freed {formatBytes(runResult.totalReclaimedBytes)}
              {runResult.removedDirs > 0
                ? ` across ${runResult.removedDirs} item${runResult.removedDirs === 1 ? '' : 's'}`
                : ''}
              {runResult.skipped > 0 ? ` · ${runResult.skipped} skipped (in use or locked)` : ''}
            </p>
          </div>
        ) : null}

        {cleanupError ? (
          <div className="px-4 pb-3">
            <p className="m-0 text-xs text-danger" role="alert">
              {cleanupError}
            </p>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Retention policy">
        <SettingsField
          id="storage-checkpoint-gc"
          title="Checkpoint cleanup"
          hint={
            storage.checkpointGcEnabled
              ? `Keeps the newest ${storage.checkpointKeepSessions} sessions with checkpoint data; older undo history is deleted after ${storage.checkpointMaxAgeDays} days.`
              : 'Off = keep everything forever, as today.'
          }
          help="Checkpoints snapshot prior file content so you can undo agent edits. Discarded (resolved/undone) checkpoints are always cleaned first — that is data you already threw away. Turn off to keep every undo point indefinitely."
        >
          <Switch
            size="md"
            checked={storage.checkpointGcEnabled}
            disabled={form.formLocked}
            label="Checkpoint cleanup"
            onCheckedChange={(checked) => patchStorage({ checkpointGcEnabled: checked })}
          />
        </SettingsField>

        <SettingsField
          id="storage-checkpoint-keep"
          title="Keep checkpoint sessions"
          hint={`Newest ${storage.checkpointKeepSessions} sessions per workspace keep their undo data (5–100).`}
          help="Measured sessions average well under 1 MB of checkpoints each; 20 keeps a typical week of undo depth cheaply."
        >
          <input
            type="number"
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            aria-label="Keep checkpoint sessions"
            min={5}
            max={100}
            defaultValue={storage.checkpointKeepSessions}
            key={`ckpt-keep-${storage.checkpointKeepSessions}`}
            disabled={form.formLocked || !storage.checkpointGcEnabled}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (!Number.isFinite(v) || v < 5 || v > 100) {
                e.target.value = String(storage.checkpointKeepSessions)
                form.setErrorMessage('Keep checkpoint sessions must be from 5 to 100.')
                return
              }
              if (v !== storage.checkpointKeepSessions) patchStorage({ checkpointKeepSessions: v })
            }}
          />
        </SettingsField>

        <SettingsField
          id="storage-checkpoint-age"
          title="Checkpoint age backstop"
          hint={`Sessions older than ${storage.checkpointMaxAgeDays} days lose undo data even under the count cap (7–365).`}
          help="A hard age ceiling so a workspace used rarely still cannot accumulate years of undo history."
        >
          <input
            type="number"
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            aria-label="Checkpoint age backstop days"
            min={7}
            max={365}
            defaultValue={storage.checkpointMaxAgeDays}
            key={`ckpt-age-${storage.checkpointMaxAgeDays}`}
            disabled={form.formLocked || !storage.checkpointGcEnabled}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (!Number.isFinite(v) || v < 7 || v > 365) {
                e.target.value = String(storage.checkpointMaxAgeDays)
                form.setErrorMessage('Checkpoint age backstop must be from 7 to 365 days.')
                return
              }
              if (v !== storage.checkpointMaxAgeDays) patchStorage({ checkpointMaxAgeDays: v })
            }}
          />
        </SettingsField>

        <SettingsField
          id="storage-orphan-reaper"
          title="Untracked workspace storage cleanup"
          hint={
            storage.orphanReaperEnabled
              ? `Reports storage dirs the app no longer tracks as cleanable after ${storage.orphanGraceDays} idle days. Deletion always needs your confirmation.`
              : 'Off = keep everything forever, as today.'
          }
          help="Each workspace ever opened mints ~100 MB of local indexes under app data. When a workspace is no longer tracked anywhere (not open, recent, or referenced), its dir is flagged untracked; after the grace window it is listed as safe to clean. Nothing is ever deleted without an explicit confirm in the Free up space flow."
        >
          <Switch
            size="md"
            checked={storage.orphanReaperEnabled}
            disabled={form.formLocked}
            label="Untracked workspace storage cleanup"
            onCheckedChange={(checked) => patchStorage({ orphanReaperEnabled: checked })}
          />
        </SettingsField>

        <SettingsField
          id="storage-orphan-grace"
          title="Untracked grace window"
          hint={`Untracked dirs must be idle ${storage.orphanGraceDays} days before they are listed as cleanable (1–365). Derived index dirs left by deleted instance worktrees are cleanable immediately.`}
          help="Protects a dir minted seconds before a crash from being treated as dead — worst case we hold ~100 MB for a month."
        >
          <input
            type="number"
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            aria-label="Untracked grace window days"
            min={1}
            max={365}
            defaultValue={storage.orphanGraceDays}
            key={`orphan-grace-${storage.orphanGraceDays}`}
            disabled={form.formLocked || !storage.orphanReaperEnabled}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (!Number.isFinite(v) || v < 1 || v > 365) {
                e.target.value = String(storage.orphanGraceDays)
                form.setErrorMessage('Untracked grace window must be from 1 to 365 days.')
                return
              }
              if (v !== storage.orphanGraceDays) patchStorage({ orphanGraceDays: v })
            }}
          />
        </SettingsField>

        <SettingsField
          id="storage-prune-on-removal"
          title="Delete storage when removing a workspace"
          hint="When on, closing a workspace offers to also delete its app-data storage (size shown before you confirm)."
          help="Session transcripts are the archival copy of your chats — deleting a workspace's storage deletes that history, so the confirm dialog always shows the measured size first."
        >
          <Switch
            size="md"
            checked={storage.pruneOnWorkspaceRemoval}
            disabled={form.formLocked}
            label="Delete storage on workspace removal"
            onCheckedChange={(checked) => patchStorage({ pruneOnWorkspaceRemoval: checked })}
          />
        </SettingsField>

        <SettingsField
          id="storage-session-retention"
          title="Automatic session retention"
          hint={
            storage.sessionRetentionEnabled
              ? `Deletes sessions beyond the newest ${storage.sessionKeepCount} once they are older than ${storage.sessionMaxAgeDays} days.`
              : 'Off = keep every session forever, as today. "Free up space" can still apply it on demand.'
          }
          help="Sessions are cheap in practice (transcripts average well under 1 MB) but unbounded. The active session and anything from the last 24 hours are never touched."
        >
          <Switch
            size="md"
            checked={storage.sessionRetentionEnabled}
            disabled={form.formLocked}
            label="Automatic session retention"
            onCheckedChange={(checked) => patchStorage({ sessionRetentionEnabled: checked })}
          />
        </SettingsField>

        <SettingsField
          id="storage-session-keep"
          title="Keep sessions count"
          hint={`Per workspace, the newest ${storage.sessionKeepCount} sessions always stay (1–200).`}
          help="Applies when session retention runs (automatic or via Free up space)."
        >
          <input
            type="number"
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            aria-label="Keep sessions count"
            min={1}
            max={200}
            defaultValue={storage.sessionKeepCount}
            key={`sess-keep-${storage.sessionKeepCount}`}
            disabled={form.formLocked || !storage.sessionRetentionEnabled}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (!Number.isFinite(v) || v < 1 || v > 200) {
                e.target.value = String(storage.sessionKeepCount)
                form.setErrorMessage('Keep sessions count must be from 1 to 200.')
                return
              }
              if (v !== storage.sessionKeepCount) patchStorage({ sessionKeepCount: v })
            }}
          />
        </SettingsField>

        <SettingsField
          id="storage-session-age"
          title="Session age window"
          hint={`Sessions older than ${storage.sessionMaxAgeDays} days are eligible for deletion beyond the keep count (7–365).`}
          help="Both bounds apply: a session is deleted only when it is beyond the keep count AND older than this window."
        >
          <input
            type="number"
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            aria-label="Session age window days"
            min={7}
            max={365}
            defaultValue={storage.sessionMaxAgeDays}
            key={`sess-age-${storage.sessionMaxAgeDays}`}
            disabled={form.formLocked || !storage.sessionRetentionEnabled}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (!Number.isFinite(v) || v < 7 || v > 365) {
                e.target.value = String(storage.sessionMaxAgeDays)
                form.setErrorMessage('Session age window must be from 7 to 365 days.')
                return
              }
              if (v !== storage.sessionMaxAgeDays) patchStorage({ sessionMaxAgeDays: v })
            }}
          />
        </SettingsField>

        <SettingsField
          id="storage-size-cap"
          title="Managed size cap"
          hint={`Backstop over checkpoints, transcripts, indexes, worktrees, traces, and logs: ${storage.sizeCapGb} GB. Local models are reported but never auto-deleted.`}
          help="When the managed set exceeds the cap, the oldest checkpoint data is evicted until it fits. Dictation models, embedder model, browser partitions, and cache are excluded from eviction — they are shown in the report only."
        >
          <input
            type="number"
            className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg"
            aria-label="Managed size cap GB"
            min={1}
            max={50}
            defaultValue={storage.sizeCapGb}
            key={`size-cap-${storage.sizeCapGb}`}
            disabled={form.formLocked}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value))
              if (!Number.isFinite(v) || v < 1 || v > 50) {
                e.target.value = String(storage.sizeCapGb)
                form.setErrorMessage('Managed size cap must be from 1 to 50 GB.')
                return
              }
              if (v !== storage.sizeCapGb) patchStorage({ sizeCapGb: v })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      {report && report.workspaces.length > 0 ? (
        <SettingsGroup title="Workspace storage detail">
          <div className="px-4 py-3.5" data-settings-field="storage-workspaces">
            <table className="w-full border-collapse text-xs">
              <tbody>
                {report.workspaces.map((ws) => (
                  <tr key={ws.workspaceId} className="border-t border-border/40">
                    <td className="max-w-[18rem] truncate py-1 pr-2 text-fg-strong" title={ws.path ?? ws.workspaceId}>
                      {ws.displayName ?? ws.workspaceId}
                    </td>
                    <td className="py-1 pr-2 text-right text-secondary">
                      {formatBytes(ws.bytes)}
                    </td>
                    <td className="py-1 pr-2 text-right text-muted">
                      {ws.sessionCount === 1 ? '1 session' : `${ws.sessionCount} sessions`}
                    </td>
                    <td
                      className={
                        ws.tracked
                          ? 'py-1 text-right text-muted'
                          : ws.reapable
                            ? 'py-1 text-right text-warning'
                            : 'py-1 text-right text-muted'
                      }
                    >
                      {ws.tracked
                        ? 'Tracked'
                        : ws.reapable
                          ? 'Untracked (safe to clean)'
                          : `Untracked (${ws.idleDays}d idle)`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SettingsGroup>
      ) : null}
    </SettingsStack>
  )
}
