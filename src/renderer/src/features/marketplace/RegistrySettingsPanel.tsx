import { useEffect, useState } from 'react'
import type { Settings } from '@shared/ipc'
import { Button, Input } from '@renderer/lib/ui'
import { isValidHttpUrl } from '@renderer/features/settings/utils/settingsHelpers'

/** Registry URL + remote-install acknowledgement for Marketplace Manage. */
export function RegistrySettingsPanel({
  settings,
  formLocked,
  onUpdate,
  onReloadSettings
}: {
  settings: Settings
  formLocked?: boolean
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
}) {
  const [registryUrl, setRegistryUrl] = useState(settings.marketplace?.registryUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null
  )

  useEffect(() => {
    setRegistryUrl(settings.marketplace?.registryUrl ?? '')
  }, [settings.marketplace?.registryUrl])

  const remoteAcked = settings.marketplace?.remoteInstallAcked ?? false
  const locked = Boolean(formLocked || busy)

  return (
    <section
      className="rounded-md border border-border bg-surface px-3 py-3"
      aria-label="Package registry"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-sm tracking-[var(--vy-tracking)] text-fg-strong">
            Package registry
          </p>
          <p className="m-0 mt-0.5 text-xs leading-snug text-secondary">
            Optional remote catalog URL. Unsigned packages — install only from sources you trust.
          </p>
        </div>
      </div>

      <div className="mt-2.5 flex w-full flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="marketplace-registry-url" className="text-xs text-secondary">
            Registry URL
          </label>
          <div className="flex gap-2">
            <Input
              id="marketplace-registry-url"
              className="w-full font-mono text-xs"
              value={registryUrl}
              disabled={locked}
              placeholder="https://registry.example.com"
              aria-invalid={Boolean(registryUrl.trim() && !isValidHttpUrl(registryUrl.trim()))}
              aria-describedby={feedback ? 'marketplace-registry-url-error' : undefined}
              onChange={(e) => {
                setRegistryUrl(e.target.value)
                setFeedback(null)
              }}
              onBlur={() => {
                const trimmed = registryUrl.trim()
                if (trimmed === (settings.marketplace?.registryUrl ?? '')) return
                if (trimmed && !isValidHttpUrl(trimmed)) {
                  setFeedback({
                    kind: 'error',
                    text: 'Enter a valid http(s) URL — not saved.'
                  })
                  return
                }
                setFeedback(null)
                void onUpdate({
                  marketplace: {
                    registryUrl: trimmed,
                    remoteInstallAcked: remoteAcked
                  }
                })
              }}
            />
            <Button
              variant="subtle"
              disabled={locked}
              onClick={() => {
                void (async () => {
                  const trimmed = registryUrl.trim()
                  if (trimmed && !isValidHttpUrl(trimmed)) {
                    setFeedback({ kind: 'error', text: 'Enter a valid http(s) URL — not saved.' })
                    return
                  }
                  setBusy(true)
                  setFeedback(null)
                  try {
                    await onUpdate({
                      marketplace: {
                        registryUrl: trimmed,
                        remoteInstallAcked: remoteAcked
                      }
                    })
                    const res = await window.vyotiq.marketplaceRefreshCatalog()
                    if (res.ok) {
                      setFeedback({
                        kind: 'success',
                        text: `Catalog refreshed (${res.data.packages.length} packages)`
                      })
                      window.dispatchEvent(
                        new CustomEvent('vyotiq:marketplace-catalog-refreshed')
                      )
                    } else setFeedback({ kind: 'error', text: res.error })
                  } finally {
                    setBusy(false)
                  }
                })()
              }}
            >
              Refresh
            </Button>
          </div>
        </div>

        <label className="inline-flex items-start gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0 accent-fg"
            checked={remoteAcked}
            disabled={locked}
            aria-label="Acknowledge marketplace install risk"
            onChange={(e) => {
              void (async () => {
                setBusy(true)
                try {
                  const res = await window.vyotiq.marketplaceAckRemoteInstall(e.target.checked)
                  if (!res.ok) {
                    setFeedback({ kind: 'error', text: res.error })
                    return
                  }
                  await onReloadSettings?.()
                } finally {
                  setBusy(false)
                }
              })()
            }}
          />
          <span>
            I understand marketplace packages and MCP endpoints are unsigned. Required once before
            installing non-bundled packages (or confirm when prompted).
          </span>
        </label>

        {feedback ? (
          <p
            id="marketplace-registry-url-error"
            className={`m-0 text-xs [overflow-wrap:anywhere] ${
              feedback.kind === 'error' ? 'text-danger' : 'text-secondary'
            }`}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
          >
            {feedback.text}
          </p>
        ) : null}
      </div>
    </section>
  )
}
