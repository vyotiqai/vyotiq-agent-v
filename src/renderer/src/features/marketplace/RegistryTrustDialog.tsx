import { useRef, useState, type ReactNode } from 'react'
import type { Settings } from '@shared/ipc'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { Button, Checkbox, IconButton, Input, pushToast } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { isValidHttpUrl } from '@renderer/features/settings/utils/settingsHelpers'
import { FIELD_GRID } from './McpServerConfig'
import type { MarketplaceController } from './useMarketplaceController'

const MCP_DOCS_URL = 'https://modelcontextprotocol.io/'

type Feedback = { kind: 'success' | 'error'; text: string } | null

/**
 * Where packages come from and what the app may install: the registry, the
 * one-time acknowledgement, reconnecting every server, and installing a
 * package from a folder, zip, git, npm or a remote URL.
 */
export function RegistryTrustDialog({
  settings,
  controller,
  onUpdate,
  onReloadSettings,
  onClose,
  onInstalled
}: {
  settings: Settings
  controller: MarketplaceController
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
  onClose: () => void
  /** The list key of an installed package, to select it. */
  onInstalled: (key: string) => void
}) {
  const urlRef = useRef<HTMLInputElement>(null)
  const saved = settings.marketplace?.registryUrl ?? ''
  const [registryUrl, setRegistryUrl] = useState(saved)
  const [refreshing, setRefreshing] = useState(false)
  const [acking, setAcking] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const acked = settings.marketplace?.remoteInstallAcked ?? false
  const locked = controller.formLocked || refreshing || acking

  const saveUrl = async (trimmed: string): Promise<boolean> => {
    if (trimmed && !isValidHttpUrl(trimmed)) {
      setFeedback({ kind: 'error', text: 'Enter a valid http(s) URL — not saved.' })
      return false
    }
    const res = await onUpdate({ marketplace: { registryUrl: trimmed, remoteInstallAcked: acked } })
    if (!res.ok) {
      setFeedback({ kind: 'error', text: res.error })
      return false
    }
    return true
  }

  const refresh = async (announce: boolean): Promise<void> => {
    const res = await window.vyotiq.marketplaceRefreshCatalog()
    if (!res.ok) {
      if (announce) setFeedback({ kind: 'error', text: res.error })
      return
    }
    // The list reloads on this, so the registry's packages show without a reopen.
    window.dispatchEvent(new CustomEvent('vyotiq:marketplace-catalog-refreshed'))
    if (announce) setFeedback({ kind: 'success', text: `Catalog refreshed (${res.data.packages.length} packages)` })
  }

  const commitUrl = async (): Promise<void> => {
    const trimmed = registryUrl.trim()
    if (trimmed === saved) return
    setFeedback(null)
    // A new registry: refetch, so the list does not keep the previous one's entries.
    if (await saveUrl(trimmed)) await refresh(false)
  }

  const refreshNow = async (): Promise<void> => {
    setRefreshing(true)
    setFeedback(null)
    try {
      if (registryUrl.trim() !== saved && !(await saveUrl(registryUrl.trim()))) return
      await refresh(true)
    } finally {
      setRefreshing(false)
    }
  }

  const setAck = async (next: boolean): Promise<void> => {
    setAcking(true)
    try {
      const res = await window.vyotiq.marketplaceAckRemoteInstall(next)
      if (!res.ok) {
        setFeedback({ kind: 'error', text: res.error })
        return
      }
      await onReloadSettings?.()
    } finally {
      setAcking(false)
    }
  }

  const reconnectAll = async (): Promise<void> => {
    setReconnecting(true)
    try {
      await controller.loadMcpStatus(true)
    } finally {
      setReconnecting(false)
    }
  }

  const openDocs = async (): Promise<void> => {
    const res = await window.vyotiq.shellOpenExternal(MCP_DOCS_URL)
    if (!res.ok) pushToast(res.error, 'error')
  }

  return (
    <Dialog
      open
      onClose={onClose}
      label="Registry and trust"
      useNativeDialog={false}
      padded={false}
      initialFocusRef={urlRef}
      className="vy-menu flex w-[560px] flex-col overflow-hidden"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon name="gear" size={16} className="text-muted" />
        <h2 className="text-heading font-semibold text-fg-strong">Registry and trust</h2>
        <span className="flex-1" />
        <IconButton icon="close" label="Close" size="sm" tone="muted" onClick={onClose} />
      </div>
      <div className="min-h-0 space-y-6 overflow-y-auto px-4 py-4">
        <Group label="Package registry" region>
          <div className={FIELD_GRID}>
            <label htmlFor="marketplace-registry-url" className="text-muted">
              Registry URL
            </label>
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                ref={urlRef}
                id="marketplace-registry-url"
                size="sm"
                mono
                value={registryUrl}
                disabled={locked}
                placeholder="https://registry.example.com"
                aria-invalid={Boolean(registryUrl.trim() && !isValidHttpUrl(registryUrl.trim()))}
                aria-describedby={feedback ? 'marketplace-registry-feedback' : undefined}
                onChange={(e) => {
                  setRegistryUrl(e.target.value)
                  setFeedback(null)
                }}
                onBlur={() => void commitUrl()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
              />
              <Button size="sm" variant="secondary" pending={refreshing} disabled={locked} onClick={() => void refreshNow()}>
                Refresh
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Optional. Its packages are listed beside the bundled ones, and are unsigned — add only from
            sources you trust.
          </p>
          {feedback ? (
            <p
              id="marketplace-registry-feedback"
              role={feedback.kind === 'error' ? 'alert' : 'status'}
              className={
                feedback.kind === 'error'
                  ? 'mt-2 text-xs text-danger [overflow-wrap:anywhere]'
                  : 'mt-2 text-xs text-muted [overflow-wrap:anywhere]'
              }
            >
              {feedback.text}
            </p>
          ) : null}
        </Group>

        <Group label="Trust">
          <Checkbox
            checked={acked}
            disabled={locked}
            aria-label="Acknowledge marketplace install risk"
            onCheckedChange={(next) => void setAck(next)}
            label="I understand packages and MCP endpoints are unsigned"
          />
          <p className="mt-1 pl-[22px] text-xs text-tertiary">
            Needed once before installing anything that is not bundled.
          </p>
        </Group>

        <Group label="MCP servers">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              icon="retry"
              pending={reconnecting}
              disabled={controller.formLocked}
              onClick={() => void reconnectAll()}
            >
              Reconnect all MCP servers
            </Button>
            <Button size="sm" variant="ghost" icon="external" onClick={() => void openDocs()}>
              MCP documentation
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">Reconnecting ends every running server’s calls and starts it again.</p>
        </Group>

        <InstallFromSource controller={controller} onInstalled={onInstalled} />
      </div>
    </Dialog>
  )
}

function Group({ label, region = false, children }: { label: string; region?: boolean; children: ReactNode }) {
  return (
    <section aria-label={region ? label : undefined}>
      <h3 className={`mb-2 ${SECTION_LABEL}`}>{label}</h3>
      {children}
    </section>
  )
}

/** Install a package from somewhere other than the catalog. */
function InstallFromSource({
  controller,
  onInstalled
}: {
  controller: MarketplaceController
  onInstalled: (key: string) => void
}) {
  const [gitUrl, setGitUrl] = useState('')
  const [npmName, setNpmName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteToken, setRemoteToken] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const locked = controller.formLocked || pending !== null

  const install = async (
    id: string,
    payload: Parameters<MarketplaceController['runInstall']>[0],
    clear: () => void
  ): Promise<void> => {
    setPending(id)
    try {
      const item = await controller.runInstall(payload, { busyTargetId: `marketplace-install-${id}` })
      if (!item) return
      clear()
      onInstalled(`${item.kind}:${item.id}`)
    } finally {
      setPending(null)
    }
  }

  const pickLocal = async (): Promise<void> => {
    const pick = await window.vyotiq.marketplacePickLocal()
    if (!pick.ok) {
      pushToast(pick.error, 'error')
      return
    }
    if (!pick.data) return
    const path = pick.data
    await install('path', { source: /\.(zip|tgz)$/i.test(path) ? 'zip' : 'path', target: path }, () => {})
  }

  const installRemote = async (): Promise<void> => {
    const url = remoteUrl.trim()
    if (!isValidHttpUrl(url)) {
      pushToast('Enter a valid http(s) MCP URL.', 'error')
      return
    }
    await install(
      'remote',
      { source: 'remote', target: url, kind: 'mcp', bearerToken: remoteToken.trim() || undefined },
      () => {
        setRemoteUrl('')
        setRemoteToken('')
      }
    )
  }

  return (
    <Group label="Install from source">
      <div className={FIELD_GRID}>
        <span className="text-muted">Folder or zip</span>
        <div>
          <Button size="sm" variant="secondary" icon="folderOpen" pending={pending === 'path'} disabled={locked} onClick={() => void pickLocal()}>
            Choose…
          </Button>
        </div>
        <label htmlFor="marketplace-git-url" className="text-muted">
          Git
        </label>
        <SourceRow
          id="marketplace-git-url"
          label="Git clone URL"
          placeholder="https://github.com/owner/repo"
          value={gitUrl}
          disabled={locked}
          pending={pending === 'git'}
          onChange={setGitUrl}
          onInstall={() => void install('git', { source: 'git', target: gitUrl.trim() }, () => setGitUrl(''))}
        />
        <label htmlFor="marketplace-npm-name" className="text-muted">
          npm
        </label>
        <SourceRow
          id="marketplace-npm-name"
          label="npm package name"
          placeholder="@scope/package"
          value={npmName}
          disabled={locked}
          pending={pending === 'npm'}
          onChange={setNpmName}
          onInstall={() => void install('npm', { source: 'npm', target: npmName.trim() }, () => setNpmName(''))}
        />
        <label htmlFor="marketplace-remote-url" className="text-muted">
          Remote MCP
        </label>
        <SourceRow
          id="marketplace-remote-url"
          label="Remote MCP URL"
          placeholder="https://mcp.example.com/mcp"
          value={remoteUrl}
          disabled={locked}
          pending={pending === 'remote'}
          onChange={setRemoteUrl}
          onInstall={() => void installRemote()}
        />
        <label htmlFor="marketplace-remote-token" className="text-muted">
          Token
        </label>
        <Input
          id="marketplace-remote-token"
          size="sm"
          mono
          type="password"
          autoComplete="off"
          aria-label="Remote MCP Bearer token"
          placeholder="Optional — kept in OS secure storage"
          value={remoteToken}
          disabled={locked}
          onChange={(e) => setRemoteToken(e.target.value)}
        />
      </div>
    </Group>
  )
}

function SourceRow({
  id,
  label,
  placeholder,
  value,
  disabled,
  pending,
  onChange,
  onInstall
}: {
  id: string
  label: string
  placeholder: string
  value: string
  disabled: boolean
  pending: boolean
  onChange: (value: string) => void
  onInstall: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Input
        id={id}
        size="sm"
        mono
        aria-label={label}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onInstall()
        }}
      />
      <Button size="sm" variant="secondary" pending={pending} disabled={disabled || !value.trim()} onClick={onInstall}>
        Install
      </Button>
    </div>
  )
}
