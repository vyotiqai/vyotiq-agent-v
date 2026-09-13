import { useEffect, useState } from 'react'
import type { McpServer, McpServerStatus, McpTransport } from '@shared/ipc'
import { Input, Textarea, Button, selectClass } from '@renderer/lib/ui'
import {
  hasNonBearerAuthorization,
  headersWithoutAuthorization
} from '@shared/utils/mcpAuth'
import {
  formatMcpToolNameList,
  parseMcpToolNameList
} from '@shared/utils/mcpToolPolicy'
import { isGoogleMcpId, isHostedAppMcpId, mcpOAuthFixedRedirectUrl } from '@shared/mcpApps'
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

      <div className="mt-2.5 flex flex-col gap-2">
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
            {isHostedAppMcpId(server.id) && onOpenConnect ? (
              <Button variant="subtle" disabled={disabled} onClick={onOpenConnect}>
                Connect
              </Button>
            ) : null}
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

      <p className={`m-0 mt-2 ${mcpStatusClass(status, { workspaceEnabled })}`}>
        {mcpStatusLabel(status, { workspaceEnabled })}
      </p>
      {status?.error ? (
        <p className="m-0 mt-1 text-danger [overflow-wrap:anywhere]">{status.error}</p>
      ) : null}

      {hideRemove ? null : (
        <Button variant="danger" className="mt-2" disabled={disabled} onClick={onRemove}>
          Remove
        </Button>
      )}
    </div>
  )
}
