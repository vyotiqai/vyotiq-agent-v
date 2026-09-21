import { useEffect, useState } from 'react'
import type { McpServer, McpServerStatus, McpTransport } from '@shared/ipc'
import { Input, Textarea, Button, Switch, selectClass } from '@renderer/lib/ui'
import {
  hasNonBearerAuthorization,
  headersWithoutAuthorization
} from '@shared/utils/mcpAuth'
import {
  formatMcpToolNameList,
  parseMcpToolNameList
} from '@shared/utils/mcpToolPolicy'
import {
  isGoogleMcpId,
  mcpOAuthFixedRedirectUrl,
  mcpSupportsOAuth,
  mcpUsesTokenAuth
} from '@shared/mcpApps'
import { copyText } from '@renderer/lib/markdown/copyText'
import { mcpArgsToText, mcpEnvToText, mcpTextToArgs, mcpTextToEnv } from './mcpText'
import { mcpStatusClass, mcpStatusLabel } from './mcpStatus'

export function McpServerCard({
  server,
  status,
  disabled,
  hideEnable,
  hideRemove,
  workspaceEnabled,
  googleMcpClientId,
  onUpdate,
  onRemove,
  onAuthChanged,
  onOpenConnect
}: {
  server: McpServer
  status: McpServerStatus | undefined
  disabled?: boolean
  /** When true, package-level enable in Marketplace owns the toggle. */
  hideEnable?: boolean
  /** When true, Uninstall in Marketplace owns removal. */
  hideRemove?: boolean
  /** Workspace Force off for this server; keeps status copy aligned with Browse. */
  workspaceEnabled?: boolean
  googleMcpClientId?: string
  onUpdate: (next: McpServer) => Promise<boolean>
  onRemove: () => void
  /** Called after Bearer/OAuth auth changes so the parent can refresh MCP status. */
  onAuthChanged?: () => void
  onOpenConnect?: () => void
}) {
  const transport = server.transport ?? 'stdio'
  const hasStoredToken = status?.hasAuthToken === true
  const [name, setName] = useState(server.name)
  const [command, setCommand] = useState(server.command ?? '')
  const [url, setUrl] = useState(server.url ?? '')
  const [argsText, setArgsText] = useState(mcpArgsToText(server.args))
  const [envText, setEnvText] = useState(mcpEnvToText(server.env))
  const [bearerToken, setBearerToken] = useState('')
  const [bearerDirty, setBearerDirty] = useState(false)
  const [oauthClientId, setOauthClientId] = useState(server.oauthClientId ?? '')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [oauthSecretDirty, setOauthSecretDirty] = useState(false)
  const [redirectCopied, setRedirectCopied] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [oauthPending, setOauthPending] = useState(false)
  const [allowedText, setAllowedText] = useState(() =>
    formatMcpToolNameList(server.allowedTools)
  )
  const [deniedText, setDeniedText] = useState(() =>
    formatMcpToolNameList(server.deniedTools)
  )
  const [headersText, setHeadersText] = useState(() =>
    hasNonBearerAuthorization(server.headers)
      ? mcpEnvToText(server.headers)
      : mcpEnvToText(headersWithoutAuthorization(server.headers))
  )
  /**
   * Raw connection config is collapsed by default. An always-open editor made
   * every server look like something the user had to fill in by hand — expand
   * only for a failure that editing could actually fix.
   */
  const [showAdvanced, setShowAdvanced] = useState(
    () => Boolean(status?.error) && !status?.missingBinary
  )
  const [locating, setLocating] = useState(false)

  /** Point this server at an existing binary when PATH does not find it. */
  const locateBinary = async (): Promise<void> => {
    const binary = status?.missingBinary
    if (!binary) return
    setLocating(true)
    setAuthError(null)
    try {
      // Main validates the pick is a runnable file, so a directory or a stray
      // document is rejected here rather than persisted and failing later.
      const pick = await window.vyotiq.mcpPickBinary?.(binary)
      if (!pick?.ok) {
        setAuthError(pick?.error ?? 'Could not open the file picker.')
        return
      }
      if (!pick.data.path) return
      await persist({ binaryPath: pick.data.path })
      onAuthChanged?.()
    } finally {
      setLocating(false)
    }
  }

  useEffect(() => {
    setName(server.name)
    setCommand(server.command ?? '')
    setUrl(server.url ?? '')
    setArgsText(mcpArgsToText(server.args))
    setEnvText(mcpEnvToText(server.env))
    setAllowedText(formatMcpToolNameList(server.allowedTools))
    setDeniedText(formatMcpToolNameList(server.deniedTools))
    setHeadersText(
      hasNonBearerAuthorization(server.headers)
        ? mcpEnvToText(server.headers)
        : mcpEnvToText(headersWithoutAuthorization(server.headers))
    )
    setOauthClientId(server.oauthClientId ?? '')
    if (!bearerDirty) setBearerToken('')
    if (!oauthSecretDirty) setOauthClientSecret('')
    setAuthError(null)
  }, [
    server.id,
    server.name,
    server.command,
    server.url,
    server.args,
    server.env,
    server.headers,
    server.allowedTools,
    server.deniedTools,
    server.oauthClientId,
    bearerDirty,
    oauthSecretDirty
  ])

  const persist = async (patch: Partial<McpServer>): Promise<void> => {
    const next: McpServer = { ...server, ...patch }
    const ok = await onUpdate(next)
    if (!ok) {
      setName(server.name)
      setCommand(server.command ?? '')
      setUrl(server.url ?? '')
      setArgsText(mcpArgsToText(server.args))
      setEnvText(mcpEnvToText(server.env))
      setAllowedText(formatMcpToolNameList(server.allowedTools))
      setDeniedText(formatMcpToolNameList(server.deniedTools))
      setHeadersText(
        hasNonBearerAuthorization(server.headers)
          ? mcpEnvToText(server.headers)
          : mcpEnvToText(headersWithoutAuthorization(server.headers))
      )
    }
  }

  const commitName = (): void => {
    const trimmed = name.trim()
    if (!trimmed) {
      setName(server.name)
      return
    }
    if (trimmed !== server.name) void persist({ name: trimmed })
  }

  const commitCommand = (): void => {
    const trimmed = command.trim()
    if (!trimmed) {
      setCommand(server.command ?? '')
      return
    }
    if (trimmed !== (server.command ?? '')) void persist({ command: trimmed })
  }

  const commitUrl = (): void => {
    const trimmed = url.trim()
    if (!trimmed) {
      setUrl(server.url ?? '')
      return
    }
    if (trimmed !== (server.url ?? '')) void persist({ url: trimmed })
  }

  const commitArgs = (): void => {
    const nextArgs = mcpTextToArgs(argsText)
    const prevArgs = server.args ?? []
    if (nextArgs.join('\n') === prevArgs.join('\n')) return
    void persist({ args: nextArgs.length > 0 ? nextArgs : undefined })
  }

  const commitEnv = (): void => {
    const nextEnv = mcpTextToEnv(envText)
    const prevEnv = server.env ?? {}
    const prevText = Object.entries(prevEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    const nextText = nextEnv
      ? Object.entries(nextEnv)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')
      : ''
    if (nextText === prevText) return
    void persist({ env: nextEnv })
  }

  const commitAllowed = (): void => {
    const next = parseMcpToolNameList(allowedText)
    const prev = server.allowedTools
    const prevKey = (prev ?? []).join('\n')
    const nextKey = (next ?? []).join('\n')
    if (prevKey === nextKey) return
    void persist({ allowedTools: next })
  }

  const commitDenied = (): void => {
    const next = parseMcpToolNameList(deniedText)
    const prev = server.deniedTools
    const prevKey = (prev ?? []).join('\n')
    const nextKey = (next ?? []).join('\n')
    if (prevKey === nextKey) return
    void persist({ deniedTools: next })
  }

  const commitBearer = (): void => {
    if (!bearerDirty) return
    const trimmed = bearerToken.trim()
    void (async () => {
      setAuthError(null)
      if (!trimmed) {
        if (hasStoredToken) {
          const res = await window.vyotiq.mcpClearAuthToken?.(server.id)
          if (!res?.ok) {
            setAuthError(res?.error ?? 'Could not clear auth token')
            return
          }
          onAuthChanged?.()
        }
        setBearerDirty(false)
        return
      }
      const res = await window.vyotiq.mcpSetAuthToken?.(server.id, trimmed)
      if (!res?.ok) {
        setAuthError(res?.error ?? 'Could not store auth token securely')
        return
      }
      await persist({ headers: headersWithoutAuthorization(server.headers) })
      setBearerToken('')
      setBearerDirty(false)
      onAuthChanged?.()
    })()
  }

  const commitOauthClientId = (): void => {
    const trimmed = oauthClientId.trim()
    const prev = server.oauthClientId ?? ''
    if (trimmed === prev) return
    void persist({ oauthClientId: trimmed || undefined })
  }

  const commitOauthClientSecret = (): void => {
    if (!oauthSecretDirty) return
    const trimmed = oauthClientSecret.trim()
    void (async () => {
      setAuthError(null)
      if (!trimmed) {
        if (status?.hasOAuthClientSecret && !isGoogleMcpId(server.id)) {
          const res = await window.vyotiq.mcpClearOAuthClientSecret?.(server.id)
          if (!res?.ok) {
            setAuthError(res?.error ?? 'Could not clear client secret')
            return
          }
          onAuthChanged?.()
        }
        setOauthSecretDirty(false)
        return
      }
      const res = await window.vyotiq.mcpSetOAuthClientSecret?.(server.id, trimmed)
      if (!res?.ok) {
        setAuthError(res?.error ?? 'Could not store client secret securely')
        return
      }
      setOauthClientSecret('')
      setOauthSecretDirty(false)
      onAuthChanged?.()
    })()
  }

  const commitHeaders = (): void => {
    if (hasNonBearerAuthorization(server.headers)) {
      const nextHeaders = mcpTextToEnv(headersText)
      if (mcpEnvToText(nextHeaders) === mcpEnvToText(server.headers)) return
      void persist({ headers: nextHeaders })
      return
    }
    const other = headersWithoutAuthorization(mcpTextToEnv(headersText))
    const prevOther = headersWithoutAuthorization(server.headers) ?? {}
    const prevText = Object.entries(prevOther)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    const nextText = Object.entries(other ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    if (nextText === prevText) return
    void persist({ headers: other })
  }

  const isStdio = transport === 'stdio'
  const nonBearerAuth = hasNonBearerAuthorization(server.headers)
  const google = isGoogleMcpId(server.id)
  const sharedGoogleClientId = google ? (googleMcpClientId ?? '').trim() : ''
  const clientIdReady = Boolean(oauthClientId.trim() || sharedGoogleClientId)
  const secretReady = status?.hasOAuthClientSecret === true
  const googleSignInBlocked = google && (!clientIdReady || !secretReady)
  const redirectUrl =
    status?.oauthRedirectUrl ??
    (google || clientIdReady ? mcpOAuthFixedRedirectUrl() : null)

  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 text-sm tracking-[var(--vy-tracking)] text-fg-strong truncate">
            {server.name || server.id}
          </p>
          <p className="m-0 mt-0.5 truncate text-secondary" title={server.id}>
            ID: {server.id}
            {server.source === 'marketplace' ? ' · marketplace' : ' · manual'}
          </p>
        </div>
        {hideEnable ? null : (
          <label className="inline-flex shrink-0 items-center gap-1.5 pt-0.5 text-secondary">
            <input
              type="checkbox"
              className="size-3.5 accent-fg"
              checked={server.enabled}
              disabled={disabled}
              aria-label={`Enable MCP server ${server.id}`}
              onChange={(e) => void persist({ enabled: e.target.checked })}
            />
            Enabled
          </label>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className={`m-0 ${mcpStatusClass(status, { workspaceEnabled })}`}>
          {mcpStatusLabel(status, { workspaceEnabled })}
        </p>
        {/* Connect is the point of the card — it stays out of Advanced. */}
        {(mcpSupportsOAuth(server) || mcpUsesTokenAuth(server)) && onOpenConnect ? (
          <Button variant="subtle" disabled={disabled} onClick={onOpenConnect}>
            {hasStoredToken || status?.connected ? 'Reconnect' : 'Connect'}
          </Button>
        ) : null}
      </div>

      {status?.missingBinary ? (
        <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-border bg-surface px-2.5 py-2">
          <p className="m-0 text-xs text-fg">
            <span className="font-mono">{status.missingBinary}</span> was not found on PATH, so
            this server cannot start.
          </p>
          <p className="m-0 text-caption text-secondary">
            Install it, or point Agent V at a copy you already have.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {status.missingBinaryInstallUrl ? (
              <Button
                variant="subtle"
                disabled={disabled}
                onClick={() =>
                  void window.vyotiq.shellOpenExternal(status.missingBinaryInstallUrl as string)
                }
              >
                Install {status.missingBinary}
              </Button>
            ) : null}
            <Button
              variant="subtle"
              pending={locating}
              disabled={disabled || locating}
              onClick={() => void locateBinary()}
            >
              Locate binary…
            </Button>
          </div>
          {server.binaryPath ? (
            <p className="m-0 text-caption text-muted [overflow-wrap:anywhere]">
              Using {server.binaryPath}
            </p>
          ) : null}
        </div>
      ) : status?.error ? (
        <p className="m-0 mt-1 text-danger [overflow-wrap:anywhere]">{status.error}</p>
      ) : null}

      <button
        type="button"
        className="mt-2 self-start text-xs text-secondary underline-offset-2 hover:text-fg hover:underline"
        aria-expanded={showAdvanced}
        aria-controls={`mcp-advanced-${server.id}`}
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? 'Hide advanced' : 'Advanced'}
      </button>

      <div
        id={`mcp-advanced-${server.id}`}
        hidden={!showAdvanced}
        className="mt-2.5 flex flex-col gap-2"
      >
        <Input
          className="w-full"
          aria-label={`MCP server name for ${server.id}`}
          placeholder="Display name"
          disabled={disabled}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <select
          className={selectClass}
          aria-label={`MCP transport for ${server.id}`}
          disabled={disabled}
          value={transport}
          onChange={(e) => {
            const next = e.target.value as McpTransport
            void persist({ transport: next })
          }}
        >
          <option value="stdio">stdio</option>
          <option value="http">http (streamable)</option>
          <option value="sse">sse</option>
        </select>
        {isStdio ? (
          <>
            <Input
              className="w-full font-mono"
              aria-label={`MCP command for ${server.id}`}
              placeholder="Command (e.g. npx)"
              disabled={disabled}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onBlur={commitCommand}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <div className="rounded-md border border-border bg-surface px-2.5 py-1">
              <Textarea
                className="min-h-[52px] font-mono text-xs"
                aria-label={`MCP arguments for ${server.id}`}
                placeholder="Arguments (one per line)"
                disabled={disabled}
                rows={3}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                onBlur={commitArgs}
              />
            </div>
            <div className="rounded-md border border-border bg-surface px-2.5 py-1">
              <Textarea
                className="min-h-[52px] font-mono text-xs"
                aria-label={`MCP environment for ${server.id}`}
                placeholder="Environment (KEY=value, one per line)"
                disabled={disabled}
                rows={2}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                onBlur={commitEnv}
              />
            </div>
          </>
        ) : (
          <>
            <Input
              className="w-full font-mono"
              aria-label={`MCP URL for ${server.id}`}
              placeholder="https://mcp.example.com/mcp"
              disabled={disabled}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <Input
              className="w-full font-mono"
              aria-label={`OAuth client ID for ${server.id}`}
              placeholder={
                sharedGoogleClientId
                  ? 'Client ID (shared Google client is set)'
                  : 'OAuth client ID (optional)'
              }
              disabled={disabled}
              value={oauthClientId}
              autoComplete="off"
              onChange={(e) => setOauthClientId(e.target.value)}
              onBlur={commitOauthClientId}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <Input
              className="w-full font-mono"
              type="password"
              autoComplete="off"
              aria-label={`OAuth client secret for ${server.id}`}
              placeholder={
                secretReady
                  ? 'Client secret stored securely — enter new value to replace'
                  : 'OAuth client secret (optional, stored in OS secure storage)'
              }
              disabled={disabled}
              value={oauthClientSecret}
              onChange={(e) => {
                setOauthClientSecret(e.target.value)
                setOauthSecretDirty(true)
              }}
              onBlur={commitOauthClientSecret}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <Input
              className="w-full font-mono"
              type="password"
              autoComplete="off"
              aria-label={`Bearer token for ${server.id}`}
              placeholder={
                hasStoredToken
                  ? 'Bearer / PAT stored securely — enter new value to replace'
                  : 'Bearer token or PAT (optional, stored in OS secure storage)'
              }
              disabled={disabled}
              value={bearerToken}
              onChange={(e) => {
                setBearerToken(e.target.value)
                setBearerDirty(true)
              }}
              onBlur={commitBearer}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            {hasStoredToken ? (
              <p className="m-0 text-caption text-secondary">
                Auth token is in OS secure storage (not settings.json). Clear the field and blur
                to remove it.
              </p>
            ) : null}
            {redirectUrl ? (
              <label className="flex flex-col gap-1 text-caption text-secondary">
                Redirect URI
                <div className="flex gap-1.5">
                  <Input
                    readOnly
                    className="font-mono"
                    aria-label={`OAuth redirect URI for ${server.id}`}
                    value={redirectUrl}
                  />
                  <Button
                    variant="subtle"
                    disabled={disabled}
                    onClick={() => {
                      void copyText(redirectUrl).then((ok) => {
                        if (!ok) return
                        setRedirectCopied(true)
                        window.setTimeout(() => setRedirectCopied(false), 1200)
                      })
                    }}
                  >
                    {redirectCopied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              </label>
            ) : null}
            {authError ? (
              <p className="m-0 text-caption text-danger [overflow-wrap:anywhere]">{authError}</p>
            ) : null}
            <Button
              variant="subtle"
              disabled={disabled || oauthPending || googleSignInBlocked}
              title={
                googleSignInBlocked
                  ? 'Add a Google Cloud client ID and secret before signing in.'
                  : undefined
              }
              onClick={() => {
                void (async () => {
                  setAuthError(null)
                  setOauthPending(true)
                  try {
                    const res = await window.vyotiq.mcpStartOAuth?.(server.id)
                    if (!res?.ok) {
                      setAuthError(res?.error ?? 'OAuth sign-in failed')
                      return
                    }
                    onAuthChanged?.()
                  } finally {
                    setOauthPending(false)
                  }
                })()
              }}
            >
              {oauthPending ? 'Signing in…' : 'Sign in with OAuth'}
            </Button>
            <p className="m-0 text-caption text-secondary">
              {googleSignInBlocked
                ? 'Google Sign in stays disabled until a client ID and stored secret exist.'
                : 'Opens your browser for Authorization Code + PKCE. Prefer this when the MCP server uses OAuth instead of a static Bearer token.'}
            </p>
            {nonBearerAuth ? (
              <p className="m-0 text-caption text-secondary">
                Custom Authorization header is set (not Bearer). Edit it under extra headers as
                Authorization=…
              </p>
            ) : null}
            <div className="rounded-md border border-border bg-surface px-2.5 py-1">
              <Textarea
                className="min-h-[52px] font-mono text-xs"
                aria-label={`MCP extra headers for ${server.id}`}
                placeholder="Extra headers (KEY=value). Prefer Bearer field for Authorization."
                disabled={disabled}
                rows={2}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                onBlur={commitHeaders}
              />
            </div>
          </>
        )}
        <div className="rounded-md border border-border bg-surface px-2.5 py-1">
          <Textarea
            className="min-h-[40px] font-mono text-xs"
            aria-label={`Allowed MCP tools for ${server.id}`}
            placeholder="Allow tools only (bare names, one per line). Empty = all."
            disabled={disabled}
            rows={2}
            value={allowedText}
            onChange={(e) => setAllowedText(e.target.value)}
            onBlur={commitAllowed}
          />
        </div>
        <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface px-2.5 py-2">
          <div className="min-w-0">
            <p className="m-0 text-caption">Load tools into every step</p>
            <p className="m-0 mt-0.5 text-caption text-secondary">
              {server.autoLoad
                ? `Every ${server.id} tool schema rides in every request of every run.`
                : `On demand: the agent sees ${server.id}'s tool names and loads the schemas when it needs them.`}
            </p>
          </div>
          <Switch
            checked={server.autoLoad === true}
            disabled={disabled}
            label={`${server.autoLoad ? 'Load' : 'Do not load'} ${server.id} tools into every step`}
            onCheckedChange={(autoLoad) => {
              void persist({ autoLoad: autoLoad ? true : undefined })
            }}
          />
        </div>
        <div className="rounded-md border border-border bg-surface px-2.5 py-1">
          <Textarea
            className="min-h-[40px] font-mono text-xs"
            aria-label={`Denied MCP tools for ${server.id}`}
            placeholder="Deny tools (bare names, one per line)"
            disabled={disabled}
            rows={2}
            value={deniedText}
            onChange={(e) => setDeniedText(e.target.value)}
            onBlur={commitDenied}
          />
        </div>
      </div>

      {hideRemove ? null : (
        <Button variant="danger" className="mt-2" disabled={disabled} onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  )
}
