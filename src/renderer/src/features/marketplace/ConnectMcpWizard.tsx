import { useMemo, useState } from 'react'
import type { McpInput, McpServerStatus, Settings } from '@shared/ipc'
import {
  GOOGLE_ACCESS_READ,
  GOOGLE_ACCESS_READ_WRITE,
  MCP_AUTH_SCOPE_ALL,
  MCP_AUTH_SCOPE_THIS,
  isGithubMcpId,
  isGoogleMcpId,
  mcpNeedsOAuthClient,
  mcpOAuthFixedRedirectUrl,
  mcpUsesTokenAuth,
  type GoogleMcpAccess,
  type McpAuthScope
} from '@shared/mcpApps'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, Input } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'

const GOOGLE_MCP_DOCS = 'https://developers.google.com/workspace/guides/configure-mcp-servers'

type GithubMethod = 'oauth' | 'pat'
/**
 * `google-client` and `inputs` only appear when the package actually needs
 * them, so the common path is a single step: Add → Sign in. Method, workspace
 * scope and Google access all have working defaults and live under Options.
 */
type WizardStep = 'google-client' | 'oauth-client' | 'inputs' | 'finish'

function inputLabel(input: McpInput): string {
  return input.label?.trim() || input.name
}

export function ConnectMcpWizard({
  serverId,
  serverName,
  settings,
  status,
  hasGoogleMcpClientSecret,
  hasGoogleMcpClient,
  activeWorkspacePath,
  onUpdate,
  onReloadSettings,
  onClose,
  onConnected
}: {
  serverId: string
  serverName: string
  settings: Settings
  status: McpServerStatus | undefined
  hasGoogleMcpClientSecret: boolean
  /** A user-configured or app-bundled Google OAuth client is available. */
  hasGoogleMcpClient: boolean
  activeWorkspacePath?: string | null
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
  onClose: () => void
  onConnected: () => void
}) {
  const google = isGoogleMcpId(serverId)
  const server = useMemo(
    () => settings.mcpServers.find((s) => s.id === serverId),
    [settings.mcpServers, serverId]
  )
  const declaredInputs = useMemo(() => server?.inputs ?? [], [server?.inputs])
  const tokenAuth = mcpUsesTokenAuth(server ?? {})
  /** Vendor has no dynamic registration — the user registers the app themselves. */
  const needsOAuthClient = mcpNeedsOAuthClient(server ?? {}) && !status?.hasOAuthClientSecret

  const [needsGoogleClient] = useState(
    () =>
      google &&
      !hasGoogleMcpClient &&
      !(
        settings.googleMcpClientId.trim() &&
        (hasGoogleMcpClientSecret || status?.hasOAuthClientSecret)
      )
  )

  const stepList = useMemo<WizardStep[]>(() => {
    const steps: WizardStep[] = []
    if (needsGoogleClient) steps.push('google-client')
    if (needsOAuthClient) steps.push('oauth-client')
    if (declaredInputs.length > 0) steps.push('inputs')
    steps.push('finish')
    return steps
  }, [needsGoogleClient, needsOAuthClient, declaredInputs.length])

  const [stepIndex, setStepIndex] = useState(0)
  const step = stepList[Math.min(stepIndex, stepList.length - 1)] ?? 'finish'
  const [clientId, setClientId] = useState(() =>
    isGoogleMcpId(serverId) ? settings.googleMcpClientId : (server?.oauthClientId ?? '')
  )
  const [clientSecret, setClientSecret] = useState('')
  const [authScope, setAuthScope] = useState<McpAuthScope>(MCP_AUTH_SCOPE_ALL)
  const [googleAccess, setGoogleAccess] = useState<GoogleMcpAccess>(GOOGLE_ACCESS_READ_WRITE)
  const [githubMethod, setGithubMethod] = useState<GithubMethod>('oauth')
  const [pat, setPat] = useState('')
  const [inputValues, setInputValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(declaredInputs.map((i) => [i.name, i.default ?? '']))
  )
  const [showOptions, setShowOptions] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)

  const redirectUrl = status?.oauthRedirectUrl ?? mcpOAuthFixedRedirectUrl()
  const workspaceReady = Boolean(activeWorkspacePath?.trim())
  const title = `Connect ${serverName}`
  const github = isGithubMcpId(serverId)
  const usingPat = github && githubMethod === 'pat'

  const missingRequiredInput = declaredInputs.some(
    (i) => i.isRequired && !(inputValues[i.name] ?? '').trim()
  )

  const copyRedirect = (): void => {
    void copyText(redirectUrl).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  /**
   * Always read the server list from main before writing it back.
   *
   * The `settings` prop is captured at render, and this dialog writes twice in
   * some flows (client credentials, then scope). Mapping over a stale list
   * would silently drop whatever the previous step just saved, and the install
   * that triggered this dialog may itself have landed after mount.
   */
  const currentServers = async (): Promise<Settings['mcpServers']> => {
    const latest = await window.vyotiq.getSettings()
    return latest.ok ? latest.data.mcpServers : settings.mcpServers
  }

  /**
   * Persist scope, Google access and any declared inputs in one settings write.
   * Values land in `env` / `headers`; main moves anything non-empty into OS
   * secure storage and leaves a redaction placeholder in settings.json.
   */
  const persistServerConfig = async (): Promise<boolean> => {
    const servers = await currentServers()
    const existing = servers.find((s) => s.id === serverId)
    if (!existing) {
      setError('MCP server is not in settings yet. Try again after install finishes.')
      return false
    }
    if (authScope === MCP_AUTH_SCOPE_THIS && !workspaceReady) {
      setError('Open a workspace to connect only there.')
      return false
    }

    const next = { ...existing, authScope }
    if (authScope === MCP_AUTH_SCOPE_THIS && activeWorkspacePath) {
      next.authWorkspacePath = activeWorkspacePath
    } else {
      delete next.authWorkspacePath
    }
    if (google) next.googleAccess = googleAccess

    if (declaredInputs.length > 0) {
      const env = { ...(existing.env ?? {}) }
      const headers = { ...(existing.headers ?? {}) }
      for (const input of declaredInputs) {
        const value = (inputValues[input.name] ?? '').trim()
        if (!value) continue
        if (input.target === 'header') headers[input.name] = value
        else env[input.name] = value
      }
      if (Object.keys(env).length > 0) next.env = env
      if (Object.keys(headers).length > 0) next.headers = headers
    }

    const res = await onUpdate({
      mcpServers: servers.map((s) => (s.id === serverId ? next : s))
    })
    if (!res.ok) {
      setError(res.error)
      return false
    }
    return true
  }

  const saveGoogleClient = async (): Promise<boolean> => {
    const id = clientId.trim()
    const secret = clientSecret.trim()
    if (!id || !secret) {
      setError('Paste the Google Cloud Web client ID and secret.')
      return false
    }
    const idRes = await onUpdate({ googleMcpClientId: id })
    if (!idRes.ok) {
      setError(idRes.error)
      return false
    }
    const secretRes = await window.vyotiq.mcpSetGoogleClientSecret?.(secret)
    if (!secretRes?.ok) {
      setError(secretRes?.error ?? 'Could not store the Google client secret.')
      return false
    }
    await onReloadSettings?.()
    return true
  }

  /** Store the vendor OAuth app's client id (settings) and secret (secure storage). */
  const saveOAuthClient = async (): Promise<boolean> => {
    const id = clientId.trim()
    const secret = clientSecret.trim()
    if (!id || !secret) {
      setError(`Paste the client ID and secret from your ${serverName} OAuth app.`)
      return false
    }
    const servers = await currentServers()
    const existing = servers.find((s) => s.id === serverId)
    if (!existing) {
      setError('MCP server is not in settings yet. Try again after install finishes.')
      return false
    }
    const res = await onUpdate({
      mcpServers: servers.map((s) => (s.id === serverId ? { ...s, oauthClientId: id } : s))
    })
    if (!res.ok) {
      setError(res.error)
      return false
    }
    const secretRes = await window.vyotiq.mcpSetOAuthClientSecret?.(serverId, secret)
    if (!secretRes?.ok) {
      setError(secretRes?.error ?? 'Could not store the client secret.')
      return false
    }
    await onReloadSettings?.()
    return true
  }

  const connect = async (): Promise<void> => {
    setError(null)
    setPending(true)
    try {
      const saved = await persistServerConfig()
      if (!saved) return

      if (usingPat) {
        const token = pat.trim()
        if (!token) {
          setError('Paste a GitHub personal access token.')
          return
        }
        const tokenRes = await window.vyotiq.mcpSetAuthToken?.(serverId, token)
        if (!tokenRes?.ok) {
          setError(tokenRes?.error ?? 'Could not store the token.')
          return
        }
        onConnected()
        onClose()
        return
      }

      // Token packages have no browser flow — the inputs are the credential, so
      // saving them and refreshing status is the whole connect.
      if (tokenAuth) {
        await onReloadSettings?.()
        onConnected()
        onClose()
        return
      }

      const res = await window.vyotiq.mcpStartOAuth?.(serverId, {
        authScope,
        ...(authScope === MCP_AUTH_SCOPE_THIS && activeWorkspacePath
          ? { workspacePath: activeWorkspacePath }
          : {}),
        ...(google ? { googleAccess } : {})
      })
      if (!res?.ok) {
        setError(res?.error ?? 'Sign in failed')
        return
      }
      onConnected()
      onClose()
    } finally {
      setPending(false)
    }
  }

  const goNext = async (): Promise<void> => {
    setError(null)
    if (step === 'google-client') {
      setPending(true)
      try {
        if (!(await saveGoogleClient())) return
      } finally {
        setPending(false)
      }
    }
    if (step === 'oauth-client') {
      setPending(true)
      try {
        if (!(await saveOAuthClient())) return
      } finally {
        setPending(false)
      }
    }
    if (step === 'finish') {
      await connect()
      return
    }
    setStepIndex((i) => Math.min(i + 1, stepList.length - 1))
  }

  const googleSignInBlocked =
    google &&
    !hasGoogleMcpClient &&
    !(
      (clientId.trim() || settings.googleMcpClientId.trim()) &&
      (clientSecret.trim() || hasGoogleMcpClientSecret || status?.hasOAuthClientSecret)
    )

  const finishDisabled =
    pending ||
    googleSignInBlocked ||
    (usingPat && !pat.trim()) ||
    (tokenAuth && missingRequiredInput) ||
    (authScope === MCP_AUTH_SCOPE_THIS && !workspaceReady)

  const primaryLabel = (): string => {
    if (step !== 'finish') return 'Continue'
    if (pending) return tokenAuth || usingPat ? 'Connecting…' : 'Signing in…'
    return tokenAuth || usingPat ? 'Connect' : 'Sign in'
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description="Sign in so Agent V can load this MCP’s tools."
      useNativeDialog
      className="max-w-lg"
    >
      <div className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="m-0 text-md font-semibold text-fg-strong">{title}</h2>
          <p className="m-0 mt-1 text-sm text-secondary">
            Installed packages stay disconnected until you sign in. Agent V will not see these
            tools until connect succeeds.
          </p>
        </div>

        {step === 'google-client' ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm text-fg">
              This build ships without a Google client, so connect with your own. Create a Google
              Cloud Web application OAuth client, enable the Gmail, Drive and Calendar APIs plus
              the gmailmcp / drivemcp / calendarmcp services, add this redirect URI, then paste the
              client ID and secret. Later Google apps reuse this client.
            </p>
            <label className="flex flex-col gap-1 text-xs text-secondary">
              Redirect URI
              <div className="flex gap-1.5">
                <Input readOnly value={redirectUrl} aria-label="OAuth redirect URI" className="font-mono" />
                <Button variant="subtle" onClick={copyRedirect}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </label>
            <Button
              variant="subtle"
              onClick={() => void window.vyotiq.shellOpenExternal(GOOGLE_MCP_DOCS)}
            >
              Google Cloud MCP setup
            </Button>
            <Input
              aria-label="Google Cloud client ID"
              placeholder="Client ID"
              value={clientId}
              autoComplete="off"
              onChange={(e) => setClientId(e.target.value)}
            />
            <Input
              type="password"
              aria-label="Google Cloud client secret"
              placeholder="Client secret"
              value={clientSecret}
              autoComplete="off"
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
        ) : null}

        {step === 'oauth-client' ? (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm text-fg">
              {serverName} does not support automatic app registration, so register an OAuth app
              with them once and paste its credentials. Add the redirect URI below to that app.
            </p>
            <label className="flex flex-col gap-1 text-xs text-secondary">
              Redirect URI
              <div className="flex gap-1.5">
                <Input
                  readOnly
                  value={redirectUrl}
                  aria-label="OAuth redirect URI"
                  className="font-mono"
                />
                <Button variant="subtle" onClick={copyRedirect}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </label>
            {server?.setupUrl ? (
              <Button
                variant="subtle"
                onClick={() => void window.vyotiq.shellOpenExternal(server.setupUrl as string)}
              >
                Register an app with {serverName}
              </Button>
            ) : null}
            <Input
              aria-label="OAuth client ID"
              placeholder="Client ID"
              value={clientId}
              autoComplete="off"
              onChange={(e) => setClientId(e.target.value)}
            />
            <Input
              type="password"
              aria-label="OAuth client secret"
              placeholder="Client secret"
              value={clientSecret}
              autoComplete="off"
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <p className="m-0 text-caption text-muted">
              The secret is stored in OS secure storage, never in settings.json.
            </p>
          </div>
        ) : null}

        {step === 'inputs' ? (
          <div className="flex flex-col gap-2.5">
            <p className="m-0 text-sm text-fg">
              {serverName} needs {declaredInputs.length === 1 ? 'a value' : 'these values'} before
              it can connect.
            </p>
            {server?.setupUrl ? (
              <Button
                variant="subtle"
                onClick={() => void window.vyotiq.shellOpenExternal(server.setupUrl as string)}
              >
                Where do I get this?
              </Button>
            ) : null}
            {declaredInputs.map((input) => (
              <label key={`${input.target}:${input.name}`} className="flex flex-col gap-1 text-xs text-secondary">
                {inputLabel(input)}
                {input.isRequired ? '' : ' (optional)'}
                <Input
                  type={input.isSecret ? 'password' : 'text'}
                  autoComplete="off"
                  className="font-mono"
                  aria-label={inputLabel(input)}
                  placeholder={input.placeholder ?? input.name}
                  value={inputValues[input.name] ?? ''}
                  onChange={(e) =>
                    setInputValues((prev) => ({ ...prev, [input.name]: e.target.value }))
                  }
                />
                {input.description ? (
                  <span className="text-caption text-muted">{input.description}</span>
                ) : null}
              </label>
            ))}
            <p className="m-0 text-caption text-muted">
              Values are stored in OS secure storage, never in settings.json.
            </p>
          </div>
        ) : null}

        {step === 'finish' ? (
          <div className="flex flex-col gap-2">
            {usingPat ? (
              <Input
                type="password"
                aria-label="GitHub personal access token"
                placeholder="GitHub personal access token"
                value={pat}
                autoComplete="off"
                onChange={(e) => setPat(e.target.value)}
              />
            ) : (
              <p className="m-0 text-sm text-secondary">
                {tokenAuth
                  ? `Connect ${serverName} with the details above.`
                  : google
                    ? 'Sign in with Google to connect this MCP.'
                    : github
                      ? 'Sign in with GitHub to connect this MCP.'
                      : `Opens your browser to authorize ${serverName}.`}
              </p>
            )}

            <button
              type="button"
              className="m-0 self-start text-xs text-secondary underline-offset-2 hover:text-fg hover:underline"
              aria-expanded={showOptions}
              onClick={() => setShowOptions((v) => !v)}
            >
              {showOptions ? 'Hide options' : 'Options'}
            </button>

            {showOptions ? (
              <div className="flex flex-col gap-3 rounded-md border border-border bg-surface px-2.5 py-2">
                {github ? (
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-1 text-xs font-medium text-fg">Sign-in method</legend>
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <input
                        type="radio"
                        name="github-method"
                        className="mt-0.5"
                        checked={githubMethod === 'oauth'}
                        onChange={() => setGithubMethod('oauth')}
                      />
                      <span>
                        Sign in with OAuth
                        <span className="block text-xs text-secondary">
                          Copilot-capable GitHub accounts. Opens the browser.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <input
                        type="radio"
                        name="github-method"
                        className="mt-0.5"
                        checked={githubMethod === 'pat'}
                        onChange={() => setGithubMethod('pat')}
                      />
                      <span>
                        Paste a personal access token
                        <span className="block text-xs text-secondary">
                          Use a PAT when OAuth is unavailable for this account.
                        </span>
                      </span>
                    </label>
                  </fieldset>
                ) : null}

                <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                  <legend className="mb-1 text-xs font-medium text-fg">
                    Where can Agent V use this?
                  </legend>
                  <label className="flex items-start gap-2 text-sm text-fg">
                    <input
                      type="radio"
                      name="auth-scope"
                      className="mt-0.5"
                      checked={authScope === MCP_AUTH_SCOPE_ALL}
                      onChange={() => setAuthScope(MCP_AUTH_SCOPE_ALL)}
                    />
                    All workspaces
                  </label>
                  <label className="flex items-start gap-2 text-sm text-fg">
                    <input
                      type="radio"
                      name="auth-scope"
                      className="mt-0.5"
                      disabled={!workspaceReady}
                      checked={authScope === MCP_AUTH_SCOPE_THIS}
                      onChange={() => setAuthScope(MCP_AUTH_SCOPE_THIS)}
                    />
                    <span>
                      This workspace only
                      <span className="block text-xs text-secondary">
                        {workspaceReady
                          ? 'Tokens stay bound to the open workspace.'
                          : 'Open a workspace to use this option.'}
                      </span>
                    </span>
                  </label>
                </fieldset>

                {google ? (
                  <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                    <legend className="mb-1 text-xs font-medium text-fg">Access</legend>
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <input
                        type="radio"
                        name="google-access"
                        className="mt-0.5"
                        checked={googleAccess === GOOGLE_ACCESS_READ_WRITE}
                        onChange={() => setGoogleAccess(GOOGLE_ACCESS_READ_WRITE)}
                      />
                      <span>
                        Read and write
                        <span className="block text-xs text-secondary">
                          Default. Drafts, file create/update, and event create. Mutating tools
                          still need approval.
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-sm text-fg">
                      <input
                        type="radio"
                        name="google-access"
                        className="mt-0.5"
                        checked={googleAccess === GOOGLE_ACCESS_READ}
                        onChange={() => setGoogleAccess(GOOGLE_ACCESS_READ)}
                      />
                      Read only
                    </label>
                  </fieldset>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="m-0 text-caption text-danger [overflow-wrap:anywhere]">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="subtle" onClick={onClose} disabled={pending}>
            Not now
          </Button>
          {stepIndex > 0 ? (
            <Button variant="subtle" disabled={pending} onClick={() => setStepIndex((i) => i - 1)}>
              Back
            </Button>
          ) : null}
          <Button
            pending={pending}
            disabled={step === 'finish' ? finishDisabled : pending}
            onClick={() => void goNext()}
          >
            {primaryLabel()}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
