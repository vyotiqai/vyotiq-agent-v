import { useCallback, useEffect, useState } from 'react'
import type {
  Settings,
  StorageCleanupPreviewResult,
  StorageCleanupRunResult,
  StorageReportCategory,
  StorageReportResult
} from '@shared/ipc'
import { DEFAULT_STORAGE_SETTINGS } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { NumberField } from '../components/NumberField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

type CleanupStage = 'idle' | 'previewing' | 'confirming' | 'running' | 'done'

function CategoryRow({
  category,
  divider,
  action
}: {
  category: StorageReportCategory
  /** Rule above the row — off for the first row under a heading. */
  divider: boolean
  action?: { label: string; name: string; onClick: () => void }
}) {
  // Empty categories recede so the ones actually using space stand out.
  const empty = category.bytes === 0
  return (
    <tr className={divider ? 'border-t border-border/60' : undefined}>
      <td className={empty ? 'py-1.5 pr-2 text-muted' : 'py-1.5 pr-2 text-fg'}>
        {category.label}
        {action ? (
          <button
            type="button"
            aria-label={action.name}
            className="ml-2 rounded-sm text-secondary underline underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </td>
      <td className="py-1.5 pr-2 text-right tabular-nums text-secondary">
        {formatBytes(category.bytes)}
      </td>
      <td className="py-1.5 text-right tabular-nums text-muted">
        {plural(category.files, 'file')}
      </td>
    </tr>
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

  const managedCategories = report?.categories.filter((c) => c.managed) ?? []
  const keptCategories = report?.categories.filter((c) => !c.managed) ?? []
  const reclaimable = preview?.categories.filter((c) => c.reclaimBytes > 0 || c.items > 0) ?? []

  return (
    <SettingsStack>
      <SettingsGroup title="Usage">
        <SettingsField
          id="storage-usage"
          title="App data"
          hint={
            report
              ? `${formatBytes(report.totalBytes)} total · ${formatBytes(report.managedBytes)} of the ${formatBytes(report.sizeCapBytes)} cap managed${report.overCap ? ' — over the cap' : ''}`
              : 'Measuring…'
          }
          help="Measured live from app data each time this page opens and after a cleanup. The cap and the retention policy apply to the managed categories only."
        >
          <Button variant="subtle" pending={reportBusy} onClick={refreshReport}>
            {reportBusy ? 'Scanning…' : 'Rescan'}
          </Button>
        </SettingsField>
        {reportError ? (
          <p className="m-0 px-4 py-3 text-xs text-danger" role="alert">
            {reportError}
          </p>
        ) : null}
        {report && report.categories.length > 0 ? (
          <div className="px-4 py-2">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">App data by category</caption>
              <tbody>
                {managedCategories.map((category, i) => (
                  <CategoryRow key={category.id} category={category} divider={i > 0} />
                ))}
                {keptCategories.length > 0 ? (
                  <tr>
                    <th
                      colSpan={3}
                      scope="colgroup"
                      className="pb-1 pt-3 text-left text-2xs font-normal text-muted"
                    >
                      Not cleaned automatically
                    </th>
                  </tr>
                ) : null}
                {keptCategories.map((category, i) => (
                  <CategoryRow
                    key={category.id}
                    category={category}
                    divider={i > 0}
                    action={
                      category.id === 'dictation-models'
                        ? {
                            label: 'Manage',
                            name: 'Manage dictation models in Voice',
                            onClick: () => form.navigateSection('voice')
                          }
                        : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Cleanup">
        <SettingsField
          id="storage-free-up"
          title="Free up space"
          hint="Deletes what the retention policy below allows. Nothing from the last 24 hours."
          help="You see what each category would reclaim before anything is deleted. Untracked storage — indexes and sessions of workspaces the app no longer tracks — is usually the largest share."
        >
          {cleanupStage === 'previewing' || cleanupStage === 'running' ? (
            <span className="text-xs text-muted" role="status">
              {cleanupStage === 'previewing' ? 'Checking…' : 'Cleaning…'}
            </span>
          ) : cleanupStage === 'confirming' ? null : (
            <Button variant="subtle" onClick={startCleanup}>
              Free up space
            </Button>
          )}
        </SettingsField>

        {cleanupStage === 'confirming' && preview ? (
          <div className="flex flex-col gap-2 px-4 py-3">
            {preview.totalReclaimBytes > 0 || reclaimable.length > 0 ? (
              <>
                <p className="m-0 text-xs text-fg">
                  Reclaimable: {formatBytes(preview.totalReclaimBytes)}
                </p>
                <ul className="m-0 list-none p-0 text-xs text-secondary">
                  {reclaimable.map((c) => (
                    <li key={c.id} className="flex justify-between gap-3 py-0.5">
                      <span>{c.label}</span>
                      <span className="tabular-nums">
                        {formatBytes(c.reclaimBytes)}
                        {c.items > 0 ? ` · ${plural(c.items, 'item')}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
                {/* The run enforces the size cap after these categories and the
                    preview cannot size that pass, so say it may go further. */}
                {report?.overCap ? (
                  <p className="m-0 text-xs text-secondary">
                    Managed data is over the {formatBytes(report.sizeCapBytes)} cap, so the oldest
                    checkpoints may also be evicted until it fits.
                  </p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button variant="subtle" onClick={cancelCleanup}>
                    Cancel
                  </Button>
                  <Button variant="danger" onClick={confirmCleanup}>
                    Delete {formatBytes(preview.totalReclaimBytes)}
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="m-0 text-xs text-secondary">Nothing to clean up right now.</p>
                <Button variant="subtle" onClick={cancelCleanup}>
                  Close
                </Button>
              </div>
            )}
          </div>
        ) : null}

        {cleanupStage === 'done' && runResult ? (
          <p className="m-0 px-4 py-3 text-xs text-fg" role="status">
            Freed {formatBytes(runResult.totalReclaimedBytes)}
            {runResult.removedDirs > 0 ? ` across ${plural(runResult.removedDirs, 'item')}` : ''}
            {runResult.skipped > 0 ? ` · ${runResult.skipped} skipped (in use or locked)` : ''}
          </p>
        ) : null}

        {cleanupError ? (
          <p className="m-0 px-4 py-3 text-xs text-danger" role="alert">
            {cleanupError}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Retention policy">
        <SwitchField
          id="storage-checkpoint-gc"
          title="Checkpoint cleanup"
          hint={
            storage.checkpointGcEnabled
              ? 'Prunes old undo history for agent edits.'
              : 'Off: every undo point is kept forever.'
          }
          help="Checkpoints snapshot files before the agent edits them, so an edit can be undone. Undo points you already resolved or undid are always cleaned first."
          checked={storage.checkpointGcEnabled}
          disabled={form.formLocked}
          onChange={(checkpointGcEnabled) => patchStorage({ checkpointGcEnabled })}
        />
        <NumberField
          id="storage-checkpoint-keep"
          field="checkpointKeep"
          form={form}
          title="Keep checkpoint sessions"
          hint="Newest sessions per workspace that keep undo data."
          help="Sessions average well under 1 MB of checkpoints; 20 keeps about a week of undo cheaply."
          nested
          unit="sessions"
          min={5}
          max={100}
          value={storage.checkpointKeepSessions}
          disabled={form.formLocked || !storage.checkpointGcEnabled}
          onCommit={(checkpointKeepSessions) => patchStorage({ checkpointKeepSessions })}
        />
        <NumberField
          id="storage-checkpoint-age"
          field="checkpointAge"
          form={form}
          title="Checkpoint max age"
          hint="Older undo data goes even inside the session count."
          help="A ceiling so a rarely used workspace cannot pile up years of undo history."
          nested
          unit="days"
          min={7}
          max={365}
          value={storage.checkpointMaxAgeDays}
          disabled={form.formLocked || !storage.checkpointGcEnabled}
          onCommit={(checkpointMaxAgeDays) => patchStorage({ checkpointMaxAgeDays })}
        />

        <SwitchField
          id="storage-session-retention"
          title="Automatic session retention"
          hint={
            storage.sessionRetentionEnabled
              ? 'Deletes old chat sessions on a schedule.'
              : 'Off: nothing is deleted on a schedule. Free up space still applies the limits below.'
          }
          help="A session is deleted only when it is both beyond the kept count and older than the age limit. The open session and anything from the last 24 hours are never touched."
          checked={storage.sessionRetentionEnabled}
          disabled={form.formLocked}
          onChange={(sessionRetentionEnabled) => patchStorage({ sessionRetentionEnabled })}
        />
        <NumberField
          id="storage-session-keep"
          field="sessionKeep"
          form={form}
          title="Keep sessions"
          hint="Newest sessions per workspace that always stay."
          nested
          unit="sessions"
          min={1}
          max={200}
          value={storage.sessionKeepCount}
          // Editable with the switch off too: Free up space applies these
          // limits either way, so they are never inert.
          disabled={form.formLocked}
          onCommit={(sessionKeepCount) => patchStorage({ sessionKeepCount })}
        />
        <NumberField
          id="storage-session-age"
          field="sessionAge"
          form={form}
          title="Session max age"
          hint="Sessions past the count go once they are older than this."
          nested
          unit="days"
          min={7}
          max={365}
          value={storage.sessionMaxAgeDays}
          disabled={form.formLocked}
          onCommit={(sessionMaxAgeDays) => patchStorage({ sessionMaxAgeDays })}
        />

        <SwitchField
          id="storage-orphan-reaper"
          title="Untracked storage cleanup"
          hint={
            storage.orphanReaperEnabled
              ? 'Marks storage of workspaces the app no longer tracks as cleanable.'
              : 'Off: untracked storage is kept forever.'
          }
          help="Every workspace ever opened leaves about 100 MB of indexes in app data. Once a workspace is no longer open, recent, or referenced, its storage is untracked; after the grace period, Free up space offers to delete it. Nothing is deleted without your confirmation."
          checked={storage.orphanReaperEnabled}
          disabled={form.formLocked}
          onChange={(orphanReaperEnabled) => patchStorage({ orphanReaperEnabled })}
        />
        <NumberField
          id="storage-orphan-grace"
          field="orphanGrace"
          form={form}
          title="Untracked grace period"
          hint="Idle time before untracked storage counts as cleanable."
          help="Protects storage created moments before a crash. Index-only leftovers of deleted instance worktrees skip the wait."
          nested
          unit="days"
          min={1}
          max={365}
          value={storage.orphanGraceDays}
          disabled={form.formLocked || !storage.orphanReaperEnabled}
          onCommit={(orphanGraceDays) => patchStorage({ orphanGraceDays })}
        />

        <SwitchField
          id="storage-prune-on-removal"
          title="Delete storage when removing a workspace"
          hint="Closing a workspace offers to delete its app data too."
          help="That storage holds the workspace's chat history, so the confirmation always shows its measured size first."
          checked={storage.pruneOnWorkspaceRemoval}
          disabled={form.formLocked}
          onChange={(pruneOnWorkspaceRemoval) => patchStorage({ pruneOnWorkspaceRemoval })}
        />
        <NumberField
          id="storage-size-cap"
          field="sizeCap"
          form={form}
          title="Managed size cap"
          hint="Past this, the oldest checkpoints are evicted until it fits."
          help="Covers checkpoints, transcripts, indexes, worktrees, traces, and logs. Models, browser data, and cache are reported but never evicted."
          unit="GB"
          min={1}
          max={50}
          value={storage.sizeCapGb}
          disabled={form.formLocked}
          onCommit={(sizeCapGb) => patchStorage({ sizeCapGb })}
        />
      </SettingsGroup>

      {report && report.workspaces.length > 0 ? (
        <SettingsGroup title="Workspaces">
          <div className="px-4 py-2">
            <table className="w-full border-collapse text-xs">
              <caption className="sr-only">App data by workspace</caption>
              <tbody>
                {report.workspaces.map((ws) => (
                  <tr key={ws.workspaceId} className="border-t border-border/60 first:border-t-0">
                    <td
                      className="max-w-[18rem] truncate py-1.5 pr-2 text-fg"
                      title={ws.path ?? ws.workspaceId}
                    >
                      {ws.displayName ?? ws.workspaceId}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-secondary">
                      {formatBytes(ws.bytes)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-muted">
                      {plural(ws.sessionCount, 'session')}
                    </td>
                    {/* Tracked is the norm and stays quiet; a cleanable dir is
                        the one worth noticing, and says so in words. */}
                    <td
                      className={
                        !ws.tracked && ws.reapable
                          ? 'py-1.5 text-right text-warning'
                          : 'py-1.5 text-right text-muted'
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
