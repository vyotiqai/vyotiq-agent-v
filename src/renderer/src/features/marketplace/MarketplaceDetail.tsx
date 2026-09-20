import { useEffect, useMemo, useState } from 'react'
import type { MarketplaceCatalogEntry, PackageContents } from '@shared/ipc'
import { marketplaceOverrideKind } from '@shared/domain/marketplaceEnablement'
import { Button } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { PackageIcon } from './PackageIcon'
import { MarketplaceFeedbackBanner } from './MarketplaceFeedbackBanner'
import { kindLabel } from './marketplaceLabels'
import { installedActionLabel, packageActivity } from './packageActivity'
import type { MarketplaceController } from './useMarketplaceController'

function previewAsContents(entry: MarketplaceCatalogEntry): PackageContents | null {
  const preview = entry.contentsPreview
  if (!preview) return null
  return {
    id: entry.id,
    kind: entry.kind,
    mcp: (preview.mcp ?? []).map((m) => ({ id: m.id, name: m.name, path: '' })),
    skills: (preview.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description ?? '',
      path: ''
    })),
    rules: (preview.rules ?? []).map((r) => ({ path: r.path }))
  }
}

export function MarketplaceDetail({
  entry,
  controller,
  onBack,
  onOpenManage
}: {
  entry: MarketplaceCatalogEntry
  controller: MarketplaceController
  onBack: () => void
  onOpenManage: () => void
}) {
  const { installed, mcpStatusById, workspaceEnabledForId, formLocked, busyTargetId, installFromCatalog, feedback, setFeedback, openConnectWizard, loadMcpStatus } =
    controller
  const [retrying, setRetrying] = useState(false)
  const installedItem = useMemo(
    () => installed.items.find((i) => i.id === entry.id),
    [installed.items, entry.id]
  )
  const activity = packageActivity(entry, installedItem, mcpStatusById.get(entry.id), {
    workspaceEnabled: workspaceEnabledForId(marketplaceOverrideKind(entry.kind), entry.id)
  })
  const comingSoon = activity.kind === 'coming-soon'
  const isInstalled = Boolean(installedItem)
  const [contents, setContents] = useState<PackageContents | null>(null)
  const [loadingContents, setLoadingContents] = useState(true)
  const [contentsError, setContentsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingContents(true)
    setContentsError(null)
    void (async () => {
      const res = await window.vyotiq.marketplaceGetContents(entry.id)
      if (cancelled) return
      if (res.ok) {
        setContents(res.data)
        setContentsError(null)
      } else {
        setContents(previewAsContents(entry))
        setContentsError(res.error)
      }
      setLoadingContents(false)
    })()
    return () => {
      cancelled = true
    }
  }, [entry])

  return (
    <div className="flex flex-col gap-5">
      <nav className="flex items-center gap-1.5 text-xs text-muted" aria-label="Breadcrumb">
        <button
          type="button"
          className="text-secondary vy-transition hover:text-fg focus-visible:vy-focus-ring"
          onClick={onBack}
        >
          Marketplace
        </button>
        <Icon name="chevronRight" size={12} className="text-muted" />
        <span className="text-fg">{entry.name}</span>
      </nav>

      <div className="flex flex-wrap items-start gap-4">
        <PackageIcon name={entry.name} iconUrl={entry.iconUrl} iconMono={entry.iconMono} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="m-0 text-xl font-medium tracking-[var(--vy-tracking)] text-fg-strong">
              {entry.name}
            </h1>
            {entry.verified ? (
              <span className="inline-flex items-center gap-1 text-xs text-secondary">
                <Icon name="check" size={12} />
                Verified
              </span>
            ) : null}
          </div>
          <p className="m-0 mt-1 text-sm text-secondary">{entry.description || '—'}</p>
          <p className="m-0 mt-1.5 text-xs text-muted">
            {kindLabel(entry.kind)}
            {entry.publisher ? ` · ${entry.publisher}` : ''}
            {` · ${entry.id}@${entry.version}`}
            {isInstalled ? ` · ${activity.label}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {comingSoon ? (
              <span className="rounded-full bg-black/5 px-2 py-0.5 text-caption text-muted dark:bg-white/10">
                Coming soon
              </span>
            ) : isInstalled ? (
              <>
                {/* A state with a way out is a button, not a label. A public
                    server like DeepWiki declares no auth, so before this it
                    got a dead "Connect failed" chip and no Connect button
                    either — nothing on the page moved it forward. */}
                {activity.action ? (
                  <Button
                    variant={activity.kind === 'needs-auth' ? 'primary' : 'subtle'}
                    pending={retrying}
                    onClick={() => {
                      if (activity.action?.kind === 'sign-in') {
                        openConnectWizard(entry.id)
                        return
                      }
                      setRetrying(true)
                      void loadMcpStatus(true).finally(() => setRetrying(false))
                    }}
                  >
                    {activity.action.label}
                  </Button>
                ) : (
                  <Button variant="subtle" disabled className={activity.className}>
                    {installedActionLabel(activity)}
                  </Button>
                )}
                {entry.kind === 'mcp' && entry.auth && entry.auth !== 'none' ? (
                  <Button variant="subtle" onClick={() => openConnectWizard(entry.id)}>
                    {activity.kind === 'connected' ? 'Reconnect' : 'Connect'}
                  </Button>
                ) : null}
                <Button variant="subtle" onClick={onOpenManage}>
                  Manage
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                pending={busyTargetId === entry.id}
                disabled={formLocked}
                onClick={() => {
                  setFeedback(null)
                  void installFromCatalog(entry)
                }}
              >
                {busyTargetId === entry.id ? 'Installing…' : 'Add to Agent V'}
              </Button>
            )}
          </div>
        </div>
      </div>

      <MarketplaceFeedbackBanner feedback={feedback} />

      <div className="flex flex-col gap-4">
        {loadingContents ? (
          <p className="m-0 text-xs text-muted" role="status">Loading package contents…</p>
        ) : contentsError && !contents ? (
          <p className="m-0 text-xs text-danger" role="alert">
            {contentsError}
          </p>
        ) : !contents ? (
          <p className="m-0 text-xs text-muted">No package contents available.</p>
        ) : (
          <>
            {contentsError ? (
              <p className="m-0 text-xs text-muted">Showing catalog preview ({contentsError}).</p>
            ) : null}
            {contents.mcp.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <h2 className="m-0 text-sm font-medium text-fg">MCP</h2>
                <ul className="m-0 list-none space-y-1.5 p-0">
                  {contents.mcp.map((m) => (
                    <li
                      key={m.id}
                      className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
                    >
                      <p className="m-0 font-medium text-fg">{m.name}</p>
                      <p className="m-0 mt-0.5 text-muted">{m.id}</p>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {contents.skills.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <h2 className="m-0 text-sm font-medium text-fg">Skills</h2>
                <ul className="m-0 list-none space-y-1.5 p-0">
                  {contents.skills.map((s) => (
                    <li
                      key={s.name}
                      className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
                    >
                      <p className="m-0 font-medium text-fg">{s.name}</p>
                      {s.description ? (
                        <p className="m-0 mt-0.5 text-secondary">{s.description}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {contents.rules.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <h2 className="m-0 text-sm font-medium text-fg">Rules</h2>
                <ul className="m-0 list-none space-y-1.5 p-0">
                  {contents.rules.map((r) => (
                    <li
                      key={r.path}
                      className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs text-secondary"
                    >
                      {r.path}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {contents.mcp.length === 0 &&
            contents.skills.length === 0 &&
            contents.rules.length === 0 ? (
              <p className="m-0 text-xs text-muted">This package has no nested MCP, skills, or rules.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
