import { useState } from 'react'
import type { SettingsImportChange } from '@shared/ipc'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { Button, pushToast } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsGroup } from './SettingsField'

/** A value as the change list shows it: short, one line. */
function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  return 'changed'
}

function ChangeList({ changes, skipped }: { changes: SettingsImportChange[]; skipped: Array<{ key: string; reason: string }> }) {
  return (
    <div className="flex max-h-[40vh] flex-col gap-3 overflow-y-auto text-xs" data-settings-import-preview>
      {changes.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {changes.map((change) => (
            <li key={change.key} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-fg">{change.key}</span>
              <span className="min-w-0 max-w-[45%] truncate text-muted" title={`${shown(change.from)} → ${shown(change.to)}`}>
                {shown(change.from)} → <span className="text-fg">{shown(change.to)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.length > 0 ? (
        <div>
          <p className="m-0 pb-1 text-muted">Not imported:</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {skipped.map((s) => (
              <li key={s.key} className="flex gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-muted">{s.key}</span>
                <span className="min-w-0 max-w-[55%] truncate text-tertiary">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Settings as a file: save them, bring them to another computer, or start
 * over. Keys stay in the key vault throughout; MCP servers come from
 * Extensions, not a file.
 */
export function SettingsFileGroup({ form }: { form: SettingsFormState }) {
  const { confirm, dialog } = useConfirm()
  const [busy, setBusy] = useState<'export' | 'import' | 'reset' | null>(null)
  const bridge = typeof window !== 'undefined' ? window.vyotiq : undefined

  const run = async (kind: 'export' | 'import' | 'reset', job: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await job()
    } catch (err) {
      form.setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const exportFile = (): Promise<void> =>
    run('export', async () => {
      const res = await bridge!.settingsExport()
      if (!res.ok) return form.setErrorMessage(res.error)
      if (res.data.saved) pushToast('Settings exported', { detail: res.data.path })
    })

  const importFile = (): Promise<void> =>
    run('import', async () => {
      const res = await bridge!.settingsImportPreview()
      if (!res.ok) return form.setErrorMessage(res.error)
      if (!res.data.picked) return
      const { token, changes, skipped } = res.data
      if (changes.length === 0) {
        pushToast('Nothing to import', {
          detail: skipped.length ? `${skipped.length} ${skipped.length === 1 ? 'setting' : 'settings'} left out; the rest already match.` : 'These settings already match yours.'
        })
        return
      }
      const ok = await confirm(
        `${changes.length} ${changes.length === 1 ? 'setting changes' : 'settings change'}. Keys and extensions stay as they are.`,
        { title: 'Import settings', confirmLabel: 'Import', details: <ChangeList changes={changes} skipped={skipped} /> }
      )
      if (!ok) return
      const applied = await bridge!.settingsImportApply({ token })
      if (!applied.ok) return form.setErrorMessage(applied.error)
      pushToast('Settings imported')
    })

  const resetAll = (): Promise<void> =>
    run('reset', async () => {
      const ok = await confirm(
        'Every setting goes back to its default. Kept: API keys and sign-ins, custom endpoints, the provider and model tasks use, MCP servers, rules, and pinned and archived tasks.',
        { title: 'Reset all settings', confirmLabel: 'Reset', danger: true }
      )
      if (!ok) return
      const res = await bridge!.settingsReset()
      if (!res.ok) return form.setErrorMessage(res.error)
      pushToast('Settings reset')
    })

  return (
    <SettingsGroup title="Settings file">
      <SettingsField
        id="settings-export"
        title="Export settings"
        hint="To a file you can import on another computer. Keys, MCP servers and endpoint headers are left out."
      >
        <Button size="sm" variant="secondary" disabled={!bridge || busy !== null} pending={busy === 'export'} onClick={() => void exportFile()}>
          Export…
        </Button>
      </SettingsField>
      <SettingsField
        id="settings-import"
        title="Import settings"
        hint="Shows what would change first. Proxy, approvals, autonomy and where keys are sent are never taken from a file."
      >
        <Button size="sm" variant="secondary" disabled={!bridge || busy !== null} pending={busy === 'import'} onClick={() => void importFile()}>
          Import…
        </Button>
      </SettingsField>
      <SettingsField
        id="settings-reset-all"
        title="Reset all settings"
        hint="Back to the defaults. Keys, sign-ins and your tasks stay."
      >
        <Button size="sm" variant="danger" disabled={!bridge || busy !== null} pending={busy === 'reset'} onClick={() => void resetAll()}>
          Reset all…
        </Button>
      </SettingsField>
      {dialog}
    </SettingsGroup>
  )
}
