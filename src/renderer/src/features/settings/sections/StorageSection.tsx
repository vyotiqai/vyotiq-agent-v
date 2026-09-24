import { useCallback, useEffect, useState } from 'react'
import type {
  Settings,
  StorageCleanupPreviewResult,
  StorageCleanupRunResult,
  StorageReportCategory,
  StorageReportResult
} from '@shared/ipc'
import { DEFAULT_STORAGE_SETTINGS } from '@shared/ipc'
import { Button, IconButton, ProgressBar, cn } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { NumberField } from '../components/NumberField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

const MB = 1024 * 1024
const GB = 1024 * MB

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < MB) return `${Math.round(n / 1024)} KB`
  if (n < GB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`
  return `${(n / GB).toFixed(1)} GB`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

type CleanupStage = 'idle' | 'previewing' | 'confirming' | 'running' | 'done'

/** Largest first, so the row worth acting on is the one read first. */
function bySize(a: StorageReportCategory, b: StorageReportCategory): number {
  return b.bytes - a.bytes || a.label.localeCompare(b.label)
}

/**
 * The managed total against its cap, then every category with its share of
 * that total. Report-only categories (models, browser data, cache) are
 * measured too, but the cap never touches them, so they say so instead of
 * drawing a share.
 */
function StorageUsage({
  report,
  busy,
  onRescan,
  onManageModels
}: {
  report: StorageReportResult
  busy: boolean
  onRescan: () => void
  onManageModels: () => void
}) {
  const managed = report.categories.filter((c) => c.managed).sort(bySize)
  const kept = report.categories.filter((c) => !c.managed).sort(bySize)
  const managedSum = managed.reduce((sum, c) => sum + c.bytes, 0)
  return (
    <div className="mt-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-display font-medium text-fg-strong tnum">
          {formatBytes(report.managedBytes)}
        </span>
        <span className="text-sm text-muted">of a {formatBytes(report.sizeCapBytes)} managed cap</span>
        {report.overCap ? <span className="text-sm text-warning">· over the cap</span> : null}
        <span className="flex-1" />
        <span className="text-xs text-tertiary tnum">{formatBytes(report.totalBytes)} in all</span>
        <IconButton
          icon="refresh"
          label="Measure again"
          size="sm"
          tone="muted"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={onRescan}
        />
      </div>
      <ProgressBar
        value={report.managedBytes}
        max={report.sizeCapBytes}
        tone={report.overCap ? 'warning' : 'neutral'}
        label="Managed data against the cap"
        className="mt-2 w-full"
      />
      <div className="mt-4 divide-y divide-border border-y border-border">
        {[...managed, ...kept].map((category) => (
          <div key={category.id} data-storage-category={category.id} className="flex h-9 items-center gap-3 text-sm">
            <span className={cn('min-w-0 truncate', category.bytes === 0 ? 'text-muted' : 'text-fg')}>
              {category.label}
            </span>
            {category.id === 'dictation-models' ? (
              <button
                type="button"
                aria-label="Manage dictation models in Voice"
                className="shrink-0 rounded-sm text-caption text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
                onClick={onManageModels}
              >
                Manage
              </button>
            ) : null}
            <span className="flex-1" />
            {category.managed ? (
              <ProgressBar value={category.bytes} max={Math.max(managedSum, 1)} className="w-28" />
            ) : (
              <span className="w-28 text-right text-xs text-tertiary">not managed</span>
            )}
            <span
              className="w-20 text-right font-mono text-xs text-muted tnum"
              title={plural(category.files, 'file')}
            >
              {formatBytes(category.bytes)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
      .catch((err: unknown) => {
        setReportError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setReportBusy(false))
  }, [])

  // Live scan on open — the numbers are measured, never cached or estimated.
  useEffect(() => {
    refreshReport()
  }, [refreshReport])

  // §8.1 first-run ack: opening this section arms the full retention policy.
  // That is only honest because the policy is on this page — the ack means
  // "the user has seen what will be deleted".
  useEffect(() => {
    if (settings.storageSurfaceAcked) return
    if (typeof window.vyotiq?.storageAckSurface !== 'function') return
    void window.vyotiq.storageAckSurface(true)
  }, [settings.storageSurfaceAcked])

  const patchStorage = (partial: Partial<Settings['storage']>): void => {
    void form.runUpdate({ storage: { ...storage, ...partial } })
  }

  const failCleanup = (message: string): void => {
    setCleanupError(message)
    setCleanupStage('idle')
  }

  const startCleanup = (): void => {
    if (typeof window.vyotiq?.storageCleanupPreview !== 'function') return
    setCleanupStage('previewing')
    setCleanupError(null)
    setRunResult(null)
    void window.vyotiq
      .storageCleanupPreview()
      .then((res) => {
        if (!res.ok) return failCleanup(res.error)
        setPreview(res.data)
        setCleanupStage('confirming')
      })
      .catch((err: unknown) => failCleanup(err instanceof Error ? err.message : String(err)))
  }

  const confirmCleanup = (): void => {
    if (!preview || typeof window.vyotiq?.storageCleanupRun !== 'function') return
    setCleanupStage('running')
    void window.vyotiq
      .storageCleanupRun({ confirmToken: preview.confirm.token })
      .then((res) => {
        if (!res.ok) return failCleanup(res.error)
        setRunResult(res.data)
        setCleanupStage('done')
        setPreview(null)
        refreshReport()
      })
      .catch((err: unknown) => failCleanup(err instanceof Error ? err.message : String(err)))
  }

  const cancelCleanup = (): void => {
    setPreview(null)
    setCleanupStage('idle')
  }

  const reclaimable = preview?.categories.filter((c) => c.reclaimBytes > 0 || c.items > 0) ?? []

  const cleanupBelow =
    cleanupStage === 'confirming' && preview ? (
      preview.totalReclaimBytes > 0 || reclaimable.length > 0 ? (
        <div className="flex flex-col gap-2">
          <ul className="m-0 list-none divide-y divide-border border-y border-border p-0">
            {reclaimable.map((c) => (
              <li key={c.id} className="flex h-8 items-center gap-3 text-xs">
                <span className="min-w-0 flex-1 truncate text-fg">{c.label}</span>
                {c.items > 0 ? <span className="text-tertiary tnum">{plural(c.items, 'item')}</span> : null}
                <span className="w-20 text-right font-mono text-muted tnum">{formatBytes(c.reclaimBytes)}</span>
              </li>
            ))}
          </ul>
          {/* The run enforces the size cap after these categories and the
              preview cannot size that pass, so say it may go further. */}
          {report?.overCap ? (
            <p className="m-0 text-xs text-muted">
              Managed data is over the {formatBytes(report.sizeCapBytes)} cap, so the oldest checkpoints may also be
              evicted until it fits.
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={cancelCleanup}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={confirmCleanup}>
              Delete {formatBytes(preview.totalReclaimBytes)}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <p className="m-0 text-xs text-muted">Nothing to clean up right now.</p>
          <Button size="sm" variant="ghost" onClick={cancelCleanup}>
            Close
          </Button>
        </div>
      )
    ) : cleanupStage === 'done' && runResult ? (
      <p className="m-0 text-xs text-fg" role="status">
        Freed {formatBytes(runResult.totalReclaimedBytes)}
        {runResult.removedDirs > 0 ? ` across ${plural(runResult.removedDirs, 'item')}` : ''}
        {runResult.skipped > 0 ? ` · ${runResult.skipped} skipped (in use or locked)` : ''}
      </p>
    ) : cleanupError ? (
      <p className="m-0 text-xs text-danger" role="alert">
        {cleanupError}
      </p>
    ) : null

  return (
    <SettingsStack>
      <SettingsGroup title="Usage" fieldId="storage-usage" plain>
        {reportError ? (
          <p className="m-0 mt-2 text-xs text-danger" role="alert">
            {reportError}
          </p>
        ) : report ? (
          <StorageUsage
            report={report}
            busy={reportBusy}
            onRescan={refreshReport}
            onManageModels={() => form.navigateSection('voice')}
          />
        ) : (
          <p className="m-0 mt-2 text-xs text-muted" role="status">
            Measuring…
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup title="Retention">
        <SwitchField
          id="storage-checkpoint-gc"
          title="Clean up undo points"
          hint={
            storage.checkpointGcEnabled
              ? 'Prunes old undo history for agent edits.'
              : 'Off: every undo point is kept forever.'
          }
          help="Checkpoints snapshot files before the agent edits them, so an edit can be undone. Undo points you already resolved or undid are always cleaned first."
          checked={storage.checkpointGcEnabled}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'checkpointGcEnabled')}
          onChange={(checkpointGcEnabled) => patchStorage({ checkpointGcEnabled })}
        />
        <NumberField
          id="storage-checkpoint-age"
          field="checkpointAge"
          form={form}
          title="Keep undo points for"
          help="A ceiling so a rarely used workspace cannot pile up years of undo history."
          nested
          unit="days"
          min={7}
          max={365}
          value={storage.checkpointMaxAgeDays}
          disabled={form.formLocked || !storage.checkpointGcEnabled}
          {...form.nestedDefaultMark('storage', 'checkpointMaxAgeDays')}
          onCommit={(checkpointMaxAgeDays) => patchStorage({ checkpointMaxAgeDays })}
        />
        <NumberField
          id="storage-checkpoint-keep"
          field="checkpointKeep"
          form={form}
          title="Keep undo points of the newest"
          hint="Per workspace, whatever their age."
          help="Sessions average well under 1 MB of checkpoints; 20 keeps about a week of undo cheaply."
          nested
          unit="tasks"
          min={5}
          max={100}
          value={storage.checkpointKeepSessions}
          disabled={form.formLocked || !storage.checkpointGcEnabled}
          {...form.nestedDefaultMark('storage', 'checkpointKeepSessions')}
          onCommit={(checkpointKeepSessions) => patchStorage({ checkpointKeepSessions })}
        />

        <SwitchField
          id="storage-session-retention"
          title="Delete old tasks"
          hint={
            storage.sessionRetentionEnabled
              ? 'Deletes old tasks on a schedule.'
              : 'Off: nothing is deleted on a schedule. Free up space still applies the limits below.'
          }
          help="A task is deleted only when it is both beyond the kept count and older than the age limit. The open task and anything from the last 24 hours are never touched."
          checked={storage.sessionRetentionEnabled}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'sessionRetentionEnabled')}
          onChange={(sessionRetentionEnabled) => patchStorage({ sessionRetentionEnabled })}
        />
        <NumberField
          id="storage-session-age"
          field="sessionAge"
          form={form}
          title="Keep tasks for"
          nested
          unit="days"
          min={7}
          max={365}
          value={storage.sessionMaxAgeDays}
          // Editable with the switch off too: Free up space applies these
          // limits either way, so they are never inert.
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'sessionMaxAgeDays')}
          onCommit={(sessionMaxAgeDays) => patchStorage({ sessionMaxAgeDays })}
        />
        <NumberField
          id="storage-session-keep"
          field="sessionKeep"
          form={form}
          title="Always keep the newest"
          hint="Per workspace, whatever their age."
          nested
          unit="tasks"
          min={1}
          max={200}
          value={storage.sessionKeepCount}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'sessionKeepCount')}
          onCommit={(sessionKeepCount) => patchStorage({ sessionKeepCount })}
        />

        <SwitchField
          id="storage-orphan-reaper"
          title="Clean up untracked storage"
          hint={
            storage.orphanReaperEnabled
              ? 'Storage of workspaces the app no longer tracks becomes cleanable.'
              : 'Off: untracked storage is kept forever.'
          }
          help="Every workspace ever opened leaves about 100 MB of indexes in app data. Once a workspace is no longer open, recent, or referenced, its storage is untracked; after the grace period, Free up space offers to delete it. Nothing is deleted without your confirmation."
          checked={storage.orphanReaperEnabled}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'orphanReaperEnabled')}
          onChange={(orphanReaperEnabled) => patchStorage({ orphanReaperEnabled })}
        />
        <NumberField
          id="storage-orphan-grace"
          field="orphanGrace"
          form={form}
          title="Grace period"
          label="Untracked grace period"
          hint="Idle time before untracked storage counts as cleanable."
          help="Protects storage created moments before a crash. Index-only leftovers of deleted instance worktrees skip the wait."
          nested
          unit="days"
          min={1}
          max={365}
          value={storage.orphanGraceDays}
          disabled={form.formLocked || !storage.orphanReaperEnabled}
          {...form.nestedDefaultMark('storage', 'orphanGraceDays')}
          onCommit={(orphanGraceDays) => patchStorage({ orphanGraceDays })}
        />

        <SwitchField
          id="storage-prune-on-removal"
          title="Delete storage when closing a workspace"
          hint="Closing a workspace offers to delete its app data too."
          help="That storage holds the workspace's task history, so the confirmation always shows its measured size first."
          checked={storage.pruneOnWorkspaceRemoval}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'pruneOnWorkspaceRemoval')}
          onChange={(pruneOnWorkspaceRemoval) => patchStorage({ pruneOnWorkspaceRemoval })}
        />
        <NumberField
          id="storage-size-cap"
          field="sizeCap"
          form={form}
          title="Managed size cap"
          hint="Past this, the oldest undo points are evicted until it fits."
          help="Covers checkpoints, transcripts, indexes, worktrees, traces, and logs. Models, browser data, and cache are reported but never evicted."
          unit="GB"
          min={1}
          max={50}
          value={storage.sizeCapGb}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('storage', 'sizeCapGb')}
          onCommit={(sizeCapGb) => patchStorage({ sizeCapGb })}
        />
        <SettingsField
          id="storage-free-up"
          title="Free up space now"
          hint="Shows what it would delete first. Nothing from the last 24 hours."
          help="Deletes what the retention policy above allows. Untracked storage — indexes and sessions of workspaces the app no longer tracks — is usually the largest share."
          below={cleanupBelow}
        >
          {cleanupStage === 'previewing' || cleanupStage === 'running' ? (
            <span className="text-xs text-muted" role="status">
              {cleanupStage === 'previewing' ? 'Checking…' : 'Cleaning…'}
            </span>
          ) : cleanupStage === 'confirming' ? null : (
            <Button size="sm" variant="secondary" onClick={startCleanup}>
              Check…
            </Button>
          )}
        </SettingsField>
      </SettingsGroup>

      {report && report.workspaces.length > 0 ? (
        <SettingsGroup title="Workspaces" description="App data each workspace keeps" plain>
          <div className="divide-y divide-border border-y border-border">
            {report.workspaces.map((ws) => (
              <div key={ws.workspaceId} className="flex h-9 items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg" title={ws.path ?? ws.workspaceId}>
                  {ws.displayName ?? ws.workspaceId}
                </span>
                <span className="shrink-0 text-xs text-tertiary tnum">{plural(ws.sessionCount, 'task')}</span>
                {/* Tracked is the norm and stays quiet; a cleanable dir is the
                    one worth noticing, and says so in words. */}
                <span
                  className={cn(
                    'w-40 shrink-0 text-right text-xs',
                    !ws.tracked && ws.reapable ? 'text-warning' : 'text-tertiary'
                  )}
                >
                  {ws.tracked
                    ? 'Tracked'
                    : ws.reapable
                      ? 'Untracked · safe to clean'
                      : `Untracked · ${ws.idleDays}d idle`}
                </span>
                <span className="w-20 shrink-0 text-right font-mono text-xs text-muted tnum">
                  {formatBytes(ws.bytes)}
                </span>
              </div>
            ))}
          </div>
        </SettingsGroup>
      ) : null}
    </SettingsStack>
  )
}
