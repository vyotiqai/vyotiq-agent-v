import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { McpServer, McpServerStatus, McpTransport } from '@shared/ipc'
import { Button, Input, Segmented, Switch } from '@renderer/lib/ui'
import { hasNonBearerAuthorization, headersWithoutAuthorization } from '@shared/utils/mcpAuth'
import { formatMcpToolNameList, parseMcpToolNameList } from '@shared/utils/mcpToolPolicy'
import { isGoogleMcpId, mcpOAuthFixedRedirectUrl } from '@shared/mcpApps'
import { copyText } from '@renderer/lib/markdown/copyText'
import { mcpArgsToText, mcpEnvToText, mcpTextToArgs, mcpTextToEnv } from './mcpText'

/** A bordered multi-line field, the textarea twin of `Input size="sm"`. */
export const FIELD_TEXTAREA =
  'block w-full resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-tertiary vy-transition hover:border-border-strong focus-visible:border-border-strong focus-visible:vy-focus-ring disabled:vy-disabled-state'

/** Label column + field column, shared with the Add dialog. */
export const FIELD_GRID = 'grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 text-xs'

const TRANSPORTS: ReadonlyArray<{ id: McpTransport; label: string }> = [
  { id: 'stdio', label: 'stdio' },
  { id: 'http', label: 'HTTP' },
  { id: 'sse', label: 'SSE' }
]

function headersText(headers: McpServer['headers']): string {
  return hasNonBearerAuthorization(headers)
    ? mcpEnvToText(headers)
    : mcpEnvToText(headersWithoutAuthorization(headers))
}

function FieldLabel({ children, top = false }: { children: ReactNode; top?: boolean }) {
  return <span className={top ? 'self-start pt-1.5 text-muted' : 'text-muted'}>{children}</span>
}

/**
 * Everything about how a server is launched and what it may call, saved field
 * by field on blur. Sign-in, enablement and removal live in the detail header
 * above it; this is the part only someone fixing a server needs.
 */
export function McpServerConfig({
  server,
  status,
  disabled,
  googleMcpClientId,
  onUpdate,
  onAuthChanged
}: {
  server: McpServer
  status: McpServerStatus | undefined
  disabled?: boolean
  googleMcpClientId?: string
  onUpdate: (next: McpServer) => Promise<boolean>
  /** Called after a stored credential changes so the caller can re-read status. */
  onAuthChanged?: () => void
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
  const [allowedText, setAllowedText] = useState(() => formatMcpToolNameList(server.allowedTools))
  const [deniedText, setDeniedText] = useState(() => formatMcpToolNameList(server.deniedTools))
  const [headers, setHeaders] = useState(() => headersText(server.headers))

  useEffect(() => {
    setName(server.name)
    setCommand(server.command ?? '')
    setUrl(server.url ?? '')
    setArgsText(mcpArgsToText(server.args))
    setEnvText(mcpEnvToText(server.env))
    setAllowedText(formatMcpToolNameList(server.allowedTools))
    setDeniedText(formatMcpToolNameList(server.deniedTools))
    setHeaders(headersText(server.headers))
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
    const ok = await onUpdate({ ...server, ...patch })
    if (ok) return
    // A refused save puts every field back to what is stored.
    setName(server.name)
    setCommand(server.command ?? '')
    setUrl(server.url ?? '')
    setArgsText(mcpArgsToText(server.args))
    setEnvText(mcpEnvToText(server.env))
    setAllowedText(formatMcpToolNameList(server.allowedTools))
    setDeniedText(formatMcpToolNameList(server.deniedTools))
    setHeaders(headersText(server.headers))
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
    if (nextArgs.join('\n') === (server.args ?? []).join('\n')) return
    void persist({ args: nextArgs.length > 0 ? nextArgs : undefined })
  }

  const commitEnv = (): void => {
    const nextEnv = mcpTextToEnv(envText)
    if (mcpEnvToText(nextEnv) === mcpEnvToText(server.env)) return
    void persist({ env: nextEnv })
  }

  const commitAllowed = (): void => {
    const next = parseMcpToolNameList(allowedText)
    if ((next ?? []).join('\n') === (server.allowedTools ?? []).join('\n')) return
    void persist({ allowedTools: next })
  }

  const commitDenied = (): void => {
    const next = parseMcpToolNameList(deniedText)
    if ((next ?? []).join('\n') === (server.deniedTools ?? []).join('\n')) return
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
    if (trimmed === (server.oauthClientId ?? '')) return
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
      const nextHeaders = mcpTextToEnv(headers)
      if (mcpEnvToText(nextHeaders) === mcpEnvToText(server.headers)) return
      void persist({ headers: nextHeaders })
      return
    }
    const other = headersWithoutAuthorization(mcpTextToEnv(headers))
    const prevOther = headersWithoutAuthorization(server.headers)
    if (mcpEnvToText(other) === mcpEnvToText(prevOther)) return
    void persist({ headers: other })
  }

  const signInWithOAuth = async (): Promise<void> => {
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
  }

  const isStdio = transport === 'stdio'
  const nonBearerAuth = hasNonBearerAuthorization(server.headers)
  const google = isGoogleMcpId(server.id)
  const sharedGoogleClientId = google ? (googleMcpClientId ?? '').trim() : ''
  const clientIdReady = Boolean(oauthClientId.trim() || sharedGoogleClientId)
  const secretReady = status?.hasOAuthClientSecret === true
  const googleSignInBlocked = google && (!clientIdReady || !secretReady)
  const redirectUrl =
    status?.oauthRedirectUrl ?? (google || clientIdReady ? mcpOAuthFixedRedirectUrl() : null)
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') e.currentTarget.blur()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={FIELD_GRID}>
        <FieldLabel>Name</FieldLabel>
        <Input
          size="sm"
          aria-label={`MCP server name for ${server.id}`}
          placeholder="Display name"
          disabled={disabled}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={blurOnEnter}
        />
        <FieldLabel>Transport</FieldLabel>
        <div>
          <Segmented
            label={`MCP transport for ${server.id}`}
            value={transport}
            items={TRANSPORTS}
            disabled={disabled}
            onChange={(next) => {
              if (next !== transport) void persist({ transport: next })
            }}
          />
        </div>
        {isStdio ? (
          <>
            <FieldLabel>Command</FieldLabel>
            <Input
              size="sm"
              mono
              aria-label={`MCP command for ${server.id}`}
              placeholder="npx"
              disabled={disabled}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onBlur={commitCommand}
              onKeyDown={blurOnEnter}
            />
            <FieldLabel top>Arguments</FieldLabel>
            <textarea
              className={FIELD_TEXTAREA}
              aria-label={`MCP arguments for ${server.id}`}
              placeholder="One per line"
              disabled={disabled}
              rows={3}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              onBlur={commitArgs}
            />
            <FieldLabel top>Env</FieldLabel>
            <textarea
              className={FIELD_TEXTAREA}
              aria-label={`MCP environment for ${server.id}`}
              placeholder="KEY=value, one per line"
              disabled={disabled}
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              onBlur={commitEnv}
            />
          </>
        ) : (
          <>
            <FieldLabel>URL</FieldLabel>
            <Input
              size="sm"
              mono
              aria-label={`MCP URL for ${server.id}`}
              placeholder="https://mcp.example.com/mcp"
              disabled={disabled}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={blurOnEnter}
            />
            <FieldLabel>Client ID</FieldLabel>
            <Input
              size="sm"
              mono
              aria-label={`OAuth client ID for ${server.id}`}
              placeholder={sharedGoogleClientId ? 'Shared Google client is set' : 'Optional'}
              disabled={disabled}
              value={oauthClientId}
              autoComplete="off"
              onChange={(e) => setOauthClientId(e.target.value)}
              onBlur={commitOauthClientId}
              onKeyDown={blurOnEnter}
            />
            <FieldLabel>Client secret</FieldLabel>
            <Input
              size="sm"
              mono
              type="password"
              autoComplete="off"
              aria-label={`OAuth client secret for ${server.id}`}
              placeholder={secretReady ? 'Stored — type to replace' : 'Optional, kept in OS secure storage'}
              disabled={disabled}
              value={oauthClientSecret}
              onChange={(e) => {
                setOauthClientSecret(e.target.value)
                setOauthSecretDirty(true)
              }}
              onBlur={commitOauthClientSecret}
              onKeyDown={blurOnEnter}
            />
            <FieldLabel>Token</FieldLabel>
            <Input
              size="sm"
              mono
              type="password"
              autoComplete="off"
              aria-label={`Bearer token for ${server.id}`}
              placeholder={
                hasStoredToken ? 'Stored — type to replace, clear to remove' : 'Bearer or PAT, optional'
              }
              disabled={disabled}
              value={bearerToken}
              onChange={(e) => {
                setBearerToken(e.target.value)
                setBearerDirty(true)
              }}
              onBlur={commitBearer}
              onKeyDown={blurOnEnter}
            />
            {redirectUrl ? (
              <>
                <FieldLabel>Redirect URI</FieldLabel>
                <div className="flex min-w-0 items-center gap-1.5">
                  <Input
                    size="sm"
                    mono
                    readOnly
                    aria-label={`OAuth redirect URI for ${server.id}`}
                    value={redirectUrl}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
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
              </>
            ) : null}
            <FieldLabel top>Headers</FieldLabel>
            <textarea
              className={FIELD_TEXTAREA}
              aria-label={`MCP extra headers for ${server.id}`}
              placeholder={nonBearerAuth ? 'Authorization=… and others' : 'KEY=value, one per line'}
              disabled={disabled}
              rows={2}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              onBlur={commitHeaders}
            />
          </>
        )}
        <FieldLabel top>Allow only</FieldLabel>
        <textarea
          className={FIELD_TEXTAREA}
          aria-label={`Allowed MCP tools for ${server.id}`}
          placeholder="Tool names, one per line. Empty allows all."
          disabled={disabled}
          rows={2}
          value={allowedText}
          onChange={(e) => setAllowedText(e.target.value)}
          onBlur={commitAllowed}
        />
        <FieldLabel top>Never allow</FieldLabel>
        <textarea
          className={FIELD_TEXTAREA}
          aria-label={`Denied MCP tools for ${server.id}`}
          placeholder="Tool names, one per line"
          disabled={disabled}
          rows={2}
          value={deniedText}
          onChange={(e) => setDeniedText(e.target.value)}
          onBlur={commitDenied}
        />
        <FieldLabel>Every step</FieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Switch
            checked={server.autoLoad === true}
            disabled={disabled}
            label={`${server.autoLoad ? 'Load' : 'Do not load'} ${server.id} tools into every step`}
            onCheckedChange={(autoLoad) => {
              void persist({ autoLoad: autoLoad ? true : undefined })
            }}
          />
          <span className="min-w-0 text-caption text-tertiary">
            {server.autoLoad
              ? 'Its tool schemas ride in every request.'
              : 'Loaded when the agent asks for them.'}
          </span>
        </div>
      </div>

      {!isStdio ? (
        <div className="flex flex-col items-start gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            icon="key"
            pending={oauthPending}
            disabled={disabled || googleSignInBlocked}
            title={
              googleSignInBlocked ? 'Add a Google Cloud client ID and secret before signing in.' : undefined
            }
            onClick={() => void signInWithOAuth()}
          >
            {oauthPending ? 'Signing in…' : 'Sign in with OAuth'}
          </Button>
          <p className="text-caption text-tertiary">
            Opens your browser (Authorization Code + PKCE) for a server that uses OAuth rather than a
            token.
          </p>
        </div>
      ) : null}

      {authError ? (
        <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
          {authError}
        </p>
      ) : null}
    </div>
  )
}
