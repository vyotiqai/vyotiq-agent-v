import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GithubAuthStatus, McpInput, McpServerStatus, Settings } from '@shared/ipc'
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
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, Input, cn } from '@renderer/lib/ui'
import { copyText } from '@renderer/lib/markdown/copyText'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'

const GOOGLE_MCP_DOCS = 'https://developers.google.com/workspace/guides/configure-mcp-servers'

const FIELD_LABEL = 'block text-xs font-medium text-fg'

/**
 * `app` reuses the GitHub sign-in Agent V already does for itself — device
 * flow, no client secret, nothing to paste — and GitHub's hosted MCP accepts
 * that same user token as a Bearer. It is the default because the other two
 * both start with the user doing paperwork: `oauth` needs an OAuth app
 * registered by hand (GitHub advertises no dynamic registration), and `pat`
 * needs a token minted and pasted.
 */
type GithubMethod = 'app' | 'oauth' | 'pat'
/**
 * `google-client` and `inputs` only appear when the package actually needs
 * them, so the common path is a single step: Add → Sign in. Method, workspace
 * scope and Google access all have working defaults, and are shown rather
 * than folded away — they are what the sign-in button is about to act on.
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
  const github = isGithubMcpId(serverId)
  /**
   * Prefer the app's own sign-in exactly where it saves the user work: when
   * one already exists, or when the alternative is registering an OAuth app
   * by hand. A GitHub endpoint that supports dynamic registration still gets
   * the ordinary browser flow, which needs nothing either.
   */
  const [githubMethod, setGithubMethod] = useState<GithubMethod>(() => {
    if (!github) return 'oauth'
    // A credential the server has already rejected is not the one to offer
    // again: proposing it would loop the user through "already signed in" →
    // Connect → the same 401. Only the app sign-in can produce this pairing
    // (a token exists, yet the server still wants one), so route around it.
    if (status?.hasAuthToken && status.errorKind === 'sign-in') return 'oauth'
    if (status?.hasAuthToken) return 'app'
    return mcpNeedsOAuthClient(server ?? {}) && !status?.hasOAuthClientSecret ? 'app' : 'oauth'
  })
  const [githubAuth, setGithubAuth] = useState<GithubAuthStatus | null>(null)
  /**
   * True once this dialog started a device flow, so a sign-in that already
   * existed when it opened does not make it close itself immediately.
   */
  const [githubFlowStarted, setGithubFlowStarted] = useState(false)
  /** Vendor has no dynamic registration — the user registers the app themselves. */
  const needsOAuthClient =
    mcpNeedsOAuthClient(server ?? {}) &&
    !status?.hasOAuthClientSecret &&
    // Not when Agent V can supply the credential itself. This is the step the
    // whole flow was judged by: "Add" used to land the user on a form asking
    // for a client ID and secret from an app they had not registered yet.
    !(github && githubMethod === 'app')

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
  const [pat, setPat] = useState('')
  const [inputValues, setInputValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(declaredInputs.map((i) => [i.name, i.default ?? '']))
  )
  /**
   * Open. The choices here decide what the primary button is about to do —
   * which GitHub identity it signs in with, whether the credential covers
   * every workspace — and hiding them behind a link meant the user pressed
   * "Sign in with GitHub" without being shown that there were three ways to,
   * or that the default was the one needing no setup.
   */
  const [showOptions, setShowOptions] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [copied, setCopied] = useState(false)

  const redirectUrl = status?.oauthRedirectUrl ?? mcpOAuthFixedRedirectUrl()
  const workspaceReady = Boolean(activeWorkspacePath?.trim())
  const title = `Connect ${serverName}`
  const usingPat = github && githubMethod === 'pat'
  const usingAppGithub = github && githubMethod === 'app'
  const githubPending = Boolean(githubAuth?.pending)

  const missingRequiredInput = declaredInputs.some(
    (i) => i.isRequired && !(inputValues[i.name] ?? '').trim()
  )

  // Follow the app's own GitHub sign-in: its state decides what this dialog
  // shows, and the device flow finishes asynchronously in main.
  useEffect(() => {
    if (!github) return
    void window.vyotiq.githubAuthStatus?.().then((res) => {
      if (res?.ok) setGithubAuth(res.data)
    })
    return window.vyotiq.onGithubAuthStatus?.((next) => setGithubAuth(next))
  }, [github])

  useEffect(() => {
    if (!usingAppGithub || !githubFlowStarted || !githubAuth || githubAuth.pending) return
    if (githubAuth.error) {
      setError(githubAuth.error)
      setPending(false)
      setGithubFlowStarted(false)
      return
    }
    if (!githubAuth.hasAppToken) {
      // Flow over, no error, no token. Main used to reach this by cancelling
      // itself when it spotted the GitHub CLI was signed in, and the dialog
      // sat here waiting for something that was never coming. Say so rather
      // than wait, whatever ends a flow empty in future.
      setError('GitHub sign-in did not finish. Try again, or paste a personal access token.')
      setPending(false)
      setGithubFlowStarted(false)
      return
    }
    // The server reads this token straight out of the app's own storage, so
    // there is nothing left to save — just reconnect and get out of the way.
    onConnected()
    onClose()
  }, [githubAuth, githubFlowStarted, onClose, onConnected, usingAppGithub])

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

      if (usingAppGithub) {
        if (githubAuth?.hasAppToken) {
          onConnected()
          onClose()
          return
        }
        const res = await window.vyotiq.githubAuthStart?.()
        if (!res?.ok) {
          setError(res?.error ?? 'Could not start GitHub sign-in.')
          return
        }
        setGithubAuth(res.data)
        setGithubFlowStarted(true)
        // Stays open on the device code; the status listener above closes it.
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
    // The device flow runs in main and finishes on its own; pressing again
    // would abandon the code the user is in the middle of typing.
    (usingAppGithub && githubPending) ||
    googleSignInBlocked ||
    (usingPat && !pat.trim()) ||
    (tokenAuth && missingRequiredInput) ||
    (authScope === MCP_AUTH_SCOPE_THIS && !workspaceReady)

  const primaryLabel = (): string => {
    if (step !== 'finish') return 'Continue'
    if (usingAppGithub && githubPending) return 'Waiting for GitHub…'
    if (pending) return tokenAuth || usingPat ? 'Connecting…' : 'Signing in…'
    if (usingAppGithub) return githubAuth?.hasAppToken ? 'Connect' : 'Sign in with GitHub'
    return tokenAuth || usingPat ? 'Connect' : 'Sign in'
  }

  const titleId = useId()
  const descId = useId()
  const methodLabelId = useId()
  const scopeLabelId = useId()
  const accessLabelId = useId()
  /**
   * The field the step exists to fill, focused on open. A step with none (the
   * usual sign-in) leaves Dialog to focus the first control, the close button.
   */
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const redirectField = (
    <div className="space-y-1.5">
      <span className={FIELD_LABEL} aria-hidden>
        Redirect URI
      </span>
      <div className="flex gap-1.5">
        <Input size="sm" mono readOnly value={redirectUrl} aria-label="OAuth redirect URI" />
        <Button size="sm" variant="secondary" onClick={copyRedirect}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )

  return (
    <Dialog
      open
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descId}
      useNativeDialog={false}
      padded={false}
      initialFocusRef={firstFieldRef}
      className="vy-menu flex w-[560px] flex-col overflow-hidden"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={pending}>
            Not now
          </Button>
          {stepIndex > 0 ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setStepIndex((i) => i - 1)}>
              Back
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="primary"
            pending={pending}
            disabled={step === 'finish' ? finishDisabled : pending}
            onClick={() => void goNext()}
          >
            {primaryLabel()}
          </Button>
        </>
      }
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Icon name="mcp" size={16} className="text-muted" />
        <h2 id={titleId} className="min-w-0 truncate text-heading font-semibold text-fg-strong">
          {title}
        </h2>
        <span className="flex-1" />
        <IconButton icon="close" label="Close" size="sm" tone="muted" onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <p id={descId} className="m-0 text-xs text-muted">
          Installed packages stay disconnected until you sign in. Agent V will not see these tools until
          connect succeeds.
        </p>

        {step === 'google-client' ? (
          <div className="space-y-3">
            <p className="m-0 text-sm text-fg">
              This build ships without a Google client, so connect with your own. Create a Google
              Cloud Web application OAuth client, enable the Gmail, Drive and Calendar APIs plus
              the gmailmcp / drivemcp / calendarmcp services, add this redirect URI, then paste the
              client ID and secret. Later Google apps reuse this client.
            </p>
            {redirectField}
            <Button
              size="sm"
              variant="secondary"
              trailingIcon="external"
              onClick={() => void window.vyotiq.shellOpenExternal(GOOGLE_MCP_DOCS)}
            >
              Google Cloud MCP setup
            </Button>
            <div className="space-y-2">
              <Input
                ref={firstFieldRef}
                size="sm"
                aria-label="Google Cloud client ID"
                placeholder="Client ID"
                value={clientId}
                autoComplete="off"
                onChange={(e) => setClientId(e.target.value)}
              />
              <Input
                size="sm"
                type="password"
                aria-label="Google Cloud client secret"
                placeholder="Client secret"
                value={clientSecret}
                autoComplete="off"
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
          </div>
        ) : null}

        {step === 'oauth-client' ? (
          <div className="space-y-3">
            <p className="m-0 text-sm text-fg">
              {serverName} does not support automatic app registration, so register an OAuth app
              with them once and paste its credentials. Add the redirect URI below to that app.
            </p>
            {redirectField}
            {server?.setupUrl ? (
              <Button
                size="sm"
                variant="secondary"
                trailingIcon="external"
                onClick={() => void window.vyotiq.shellOpenExternal(server.setupUrl as string)}
              >
                Register an app with {serverName}
              </Button>
            ) : null}
            <div className="space-y-2">
              <Input
                ref={firstFieldRef}
                size="sm"
                aria-label="OAuth client ID"
                placeholder="Client ID"
                value={clientId}
                autoComplete="off"
                onChange={(e) => setClientId(e.target.value)}
              />
              <Input
                size="sm"
                type="password"
                aria-label="OAuth client secret"
                placeholder="Client secret"
                value={clientSecret}
                autoComplete="off"
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
            <p className="m-0 text-caption text-muted">
              The secret is stored in OS secure storage, never in settings.json.
            </p>
          </div>
        ) : null}

        {step === 'inputs' ? (
          <div className="space-y-3">
            <p className="m-0 text-sm text-fg">
              {serverName} needs {declaredInputs.length === 1 ? 'a value' : 'these values'} before
              it can connect.
            </p>
            {server?.setupUrl ? (
              <Button
                size="sm"
                variant="secondary"
                trailingIcon="external"
                onClick={() => void window.vyotiq.shellOpenExternal(server.setupUrl as string)}
              >
                Where do I get this?
              </Button>
            ) : null}
            {declaredInputs.map((input, index) => (
              <label key={`${input.target}:${input.name}`} className="block space-y-1.5">
                <span className={FIELD_LABEL}>
                  {inputLabel(input)}
                  {input.isRequired ? '' : ' (optional)'}
                </span>
                <Input
                  ref={index === 0 ? firstFieldRef : undefined}
                  size="sm"
                  mono
                  type={input.isSecret ? 'password' : 'text'}
                  autoComplete="off"
                  aria-label={inputLabel(input)}
                  placeholder={input.placeholder ?? input.name}
                  value={inputValues[input.name] ?? ''}
                  onChange={(e) =>
                    setInputValues((prev) => ({ ...prev, [input.name]: e.target.value }))
                  }
                />
                {input.description ? (
                  <span className="block text-caption text-muted">{input.description}</span>
                ) : null}
              </label>
            ))}
            <p className="m-0 text-caption text-muted">
              Values are stored in OS secure storage, never in settings.json.
            </p>
          </div>
        ) : null}

        {step === 'finish' ? (
          <div className="space-y-3">
            {usingPat ? (
              <Input
                ref={firstFieldRef}
                size="sm"
                type="password"
                aria-label="GitHub personal access token"
                placeholder="GitHub personal access token"
                value={pat}
                autoComplete="off"
                onChange={(e) => setPat(e.target.value)}
              />
            ) : usingAppGithub ? (
              githubPending && githubAuth?.userCode ? (
                <div className="space-y-2">
                  <p className="m-0 text-sm text-fg">
                    Enter this code on GitHub to finish. This dialog closes itself when it
                    goes through.
                  </p>
                  <p className="m-0 font-mono text-title tracking-[var(--vy-tracking-caps)] text-fg-strong">
                    {githubAuth.userCode}
                  </p>
                  {githubAuth.verificationUri ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      trailingIcon="external"
                      onClick={() =>
                        void window.vyotiq.shellOpenExternal(githubAuth.verificationUri as string)
                      }
                    >
                      Open GitHub again
                    </Button>
                  ) : null}
                </div>
              ) : githubAuth?.hasAppToken ? (
                <p className="m-0 text-sm text-secondary">
                  Agent V is already signed in to GitHub. {serverName} uses that sign-in —
                  there is nothing to register and nothing to paste.
                </p>
              ) : githubAuth?.ghAuthenticated ? (
                <p className="m-0 text-sm text-secondary">
                  The GitHub CLI on this machine is already signed in. {serverName} can use
                  that sign-in — no browser and no code.
                </p>
              ) : (
                <p className="m-0 text-sm text-secondary">
                  Sign in to GitHub once and {serverName} uses the same sign-in. Opens your
                  browser with a code to confirm.
                </p>
              )
            ) : (
              <p className="m-0 text-sm text-secondary">
                {tokenAuth
                  ? `Connect ${serverName} with the details above.`
                  : google
                    ? 'Sign in with Google to connect this MCP.'
                    : github
                      ? 'Sign in with GitHub to connect this MCP.'
                      : `Opens your browser to authorise ${serverName}.`}
              </p>
            )}

            {/* -ml-2 puts the label, not the button's padding, on the body's left edge. */}
            <Button
              size="xs"
              variant="ghost"
              className="-ml-2"
              trailingIcon={showOptions ? 'chevronUp' : 'chevron'}
              aria-expanded={showOptions}
              onClick={() => setShowOptions((v) => !v)}
            >
              {showOptions ? 'Hide options' : 'Options'}
            </Button>

            {showOptions ? (
              <div className="-mx-4 space-y-4 border-t border-border px-4 pt-3">
                {github ? (
                  <div>
                    <div id={methodLabelId} className={SECTION_LABEL}>
                      Sign-in method
                    </div>
                    <ChoiceRows
                      labelledBy={methodLabelId}
                      value={githubMethod}
                      onChange={setGithubMethod}
                      choices={[
                        {
                          value: 'app',
                          label: 'Use the Agent V GitHub sign-in',
                          description:
                            'Nothing to register. Reuses the sign-in Agent V already uses for Git and pull requests.'
                        },
                        {
                          value: 'oauth',
                          label: 'Sign in with your own OAuth app',
                          description: 'Needs an app registered with GitHub and its client ID and secret.'
                        },
                        {
                          value: 'pat',
                          label: 'Paste a personal access token',
                          description: 'Use a PAT when OAuth is unavailable for this account.'
                        }
                      ]}
                    />
                  </div>
                ) : null}

                <div>
                  <div id={scopeLabelId} className={SECTION_LABEL}>
                    Where can Agent V use this?
                  </div>
                  <ChoiceRows
                    labelledBy={scopeLabelId}
                    value={authScope}
                    onChange={setAuthScope}
                    choices={[
                      { value: MCP_AUTH_SCOPE_ALL, label: 'All workspaces' },
                      {
                        value: MCP_AUTH_SCOPE_THIS,
                        label: 'This workspace only',
                        description: workspaceReady
                          ? 'Tokens stay bound to the open workspace.'
                          : 'Open a workspace to use this option.',
                        disabled: !workspaceReady
                      }
                    ]}
                  />
                </div>

                {google ? (
                  <div>
                    <div id={accessLabelId} className={SECTION_LABEL}>
                      Access
                    </div>
                    <ChoiceRows
                      labelledBy={accessLabelId}
                      value={googleAccess}
                      onChange={setGoogleAccess}
                      choices={[
                        {
                          value: GOOGLE_ACCESS_READ_WRITE,
                          label: 'Read and write',
                          description:
                            'Default. Drafts, file create/update, and event create. Mutating tools still need approval.'
                        },
                        { value: GOOGLE_ACCESS_READ, label: 'Read only' }
                      ]}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="m-0 text-caption text-danger [overflow-wrap:anywhere]">{error}</p>
        ) : null}
      </div>
    </Dialog>
  )
}

type Choice<T extends string> = {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

/**
 * One radio per row, the chosen row filled — the Set up page's approval
 * choice, so every "pick one of these" in the app reads the same way. Arrow
 * keys move the choice, skipping rows that are unavailable.
 */
function ChoiceRows<T extends string>({
  labelledBy,
  value,
  choices,
  onChange
}: {
  labelledBy: string
  value: T
  choices: ReadonlyArray<Choice<T>>
  onChange: (value: T) => void
}) {
  const enabled = choices.filter((c) => !c.disabled).map((c) => c.value)
  const move = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const i = enabled.indexOf(value)
    let next = -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % enabled.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0 || enabled.length === 0) return
    e.preventDefault()
    const to = enabled[next]!
    onChange(to)
    e.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[role="radio"][data-value="${to}"]`)
      ?.focus()
  }
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="-mx-2 mt-1.5 space-y-px">
      {choices.map((c) => {
        const on = c.value === value
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            data-value={c.value}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={c.disabled}
            onClick={() => onChange(c.value)}
            onKeyDown={move}
            className={cn(
              'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left vy-transition focus-visible:vy-focus-ring disabled:vy-disabled-state',
              on ? 'bg-surface' : c.disabled ? '' : 'hover:bg-surface'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-[3px] inline-grid size-3.5 shrink-0 place-items-center rounded-full border',
                on ? 'border-accent' : 'border-border-strong'
              )}
            >
              {on ? <span className="size-1.5 rounded-full bg-accent" /> : null}
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-fg">{c.label}</span>
              {c.description ? <span className="block text-xs text-muted">{c.description}</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
