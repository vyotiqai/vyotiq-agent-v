import { useMemo, useState } from 'react'
import type { McpServerStatus, Settings } from '@shared/ipc'
import {
  GOOGLE_ACCESS_READ,
  GOOGLE_ACCESS_READ_WRITE,
  MCP_AUTH_SCOPE_ALL,
  MCP_AUTH_SCOPE_THIS,
  isGithubMcpId,
  isGoogleMcpId,
  mcpOAuthFixedRedirectUrl,
  type GoogleMcpAccess,
  type McpAuthScope
} from '@shared/mcpApps'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, Input } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'

const GOOGLE_MCP_DOCS = 'https://developers.google.com/workspace/guides/configure-mcp-servers'

type GithubMethod = 'oauth' | 'pat'
type WizardStep = 'google-client' | 'github-method' | 'workspace' | 'access' | 'finish'

function stepsFor(serverId: string, needsGoogleClient: boolean): WizardStep[] {
  if (isGoogleMcpId(serverId)) {
    return needsGoogleClient
      ? ['google-client', 'workspace', 'access', 'finish']
      : ['workspace', 'access', 'finish']
  }
  return ['github-method', 'workspace', 'finish']
}

export function ConnectMcpWizard({
  serverId,
  serverName,
  settings,
  status,
  hasGoogleMcpClientSecret,
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
  activeWorkspacePath?: string | null
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
  onClose: () => void
  onConnected: () => void
}) {
  const google = isGoogleMcpId(serverId)
  const [needsGoogleClient] = useState(
    () =>
      google &&
      !(
        settings.googleMcpClientId.trim() &&
        (hasGoogleMcpClientSecret || status?.hasOAuthClientSecret)
      )
  )
  const stepList = useMemo(
    () => stepsFor(serverId, needsGoogleClient),
    [serverId, needsGoogleClient]
  )
  const [stepIndex, setStepIndex] = useState(0)
  const step = stepList[Math.min(stepIndex, stepList.length - 1)] ?? 'finish'
  const [clientId, setClientId] = useState(settings.googleMcpClientId)
  const [clientSecret, setClientSecret] = useState('')
  const [authScope, setAuthScope] = useState<McpAuthScope>(MCP_AUTH_SCOPE_ALL)
  const [googleAccess, setGoogleAccess] = useState<GoogleMcpAccess>(GOOGLE_ACCESS_READ_WRITE)
  const [githubMethod, setGithubMethod] = useState<GithubMethod>('oauth')
  const [pat, setPat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)
  const redirectUrl = status?.oauthRedirectUrl ?? mcpOAuthFixedRedirectUrl()
  const workspaceReady = Boolean(activeWorkspacePath?.trim())
  const title = `Connect ${serverName}`

  const copyRedirect = (): void => {
    void copyText(redirectUrl).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const persistWorkspaceScope = async (): Promise<boolean> => {
    let servers = settings.mcpServers
    let server = servers.find((s) => s.id === serverId)
    if (!server) {
      const latest = await window.vyotiq.getSettings()
      if (latest.ok) servers = latest.data.mcpServers
      server = servers.find((s) => s.id === serverId)
    }
    if (!server) {
      setError('MCP server is not in settings yet. Try again after install finishes.')
      return false
    }
    if (authScope === MCP_AUTH_SCOPE_THIS && !workspaceReady) {
      setError('Open a workspace to connect only there.')
      return false
    }
    const next = { ...server, authScope }
    if (authScope === MCP_AUTH_SCOPE_THIS && activeWorkspacePath) {
      next.authWorkspacePath = activeWorkspacePath
    } else {
      delete next.authWorkspacePath
    }
    if (google) next.googleAccess = googleAccess
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

  const signIn = async (): Promise<void> => {
    setError(null)
    setPending(true)
    try {
      if (isGithubMcpId(serverId) && githubMethod === 'pat') {
        const token = pat.trim()
        if (!token) {
          setError('Paste a GitHub personal access token.')
          return
        }
        const scoped = await persistWorkspaceScope()
        if (!scoped) return
        const tokenRes = await window.vyotiq.mcpSetAuthToken?.(serverId, token)
        if (!tokenRes?.ok) {
          setError(tokenRes?.error ?? 'Could not store the token.')
          return
        }
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
        const ok = await saveGoogleClient()
        if (!ok) return
      } finally {
        setPending(false)
      }
    }
    if (step === 'finish') {
      await signIn()
      return
    }
    setStepIndex((i) => Math.min(i + 1, stepList.length - 1))
  }

  const googleSignInBlocked =
    google &&
    !(
      (clientId.trim() || settings.googleMcpClientId.trim()) &&
      (clientSecret.trim() || hasGoogleMcpClientSecret || status?.hasOAuthClientSecret)
    )

  const finishDisabled =
    pending ||
    (google && googleSignInBlocked) ||
    (isGithubMcpId(serverId) && githubMethod === 'pat' && !pat.trim()) ||
    (authScope === MCP_AUTH_SCOPE_THIS && !workspaceReady)

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
              Create a Google Cloud Web application OAuth client. Enable Gmail, Drive, and Calendar
              APIs plus the gmailmcp / drivemcp / calendarmcp services. Add this redirect URI, then
              paste the client ID and secret. Later Google apps reuse this client.
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

        {step === 'github-method' ? (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium text-fg">How do you want to sign in?</legend>
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

        {step === 'workspace' ? (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium text-fg">Where can Agent V use this?</legend>
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
        ) : null}

        {step === 'access' ? (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm font-medium text-fg">Access</legend>
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
                  Default. Drafts, file create/update, and event create. Mutating tools still need
                  approval.
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

        {step === 'finish' ? (
          <div className="flex flex-col gap-2">
            {isGithubMcpId(serverId) && githubMethod === 'pat' ? (
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
                {google
                  ? 'Sign in with Google to connect this MCP.'
                  : 'Sign in with GitHub to connect this MCP.'}
              </p>
            )}
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
            {step === 'finish'
              ? pending
                ? 'Signing in…'
                : isGithubMcpId(serverId) && githubMethod === 'pat'
                  ? 'Connect'
                  : 'Sign in'
              : 'Continue'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
