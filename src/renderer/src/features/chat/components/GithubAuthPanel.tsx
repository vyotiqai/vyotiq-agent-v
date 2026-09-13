import { useState } from 'react'
import { Button, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { copyText } from '@renderer/lib/markdown/copyText'
import type { GithubAuthStatus } from '@shared/ipc'

type GithubAuthPanelProps = {
  auth: GithubAuthStatus | null
  authBusy: boolean
  onConnect: () => void
  onCancel: () => void
  onOpenGithub: (url: string) => void
}

function AuthStep({
  number,
  label,
  active,
  done
}: {
  number: number
  label: string
  active?: boolean
  done?: boolean
}) {
  return (
    <li
      className={cn(
        'flex items-start gap-2 text-caption',
        active ? 'text-fg' : done ? 'text-muted' : 'text-muted/70'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-2xs font-medium',
          done
            ? 'bg-success/20 text-success'
            : active
              ? 'bg-accent/20 text-accent'
              : 'bg-surface-2 text-muted'
        )}
      >
        {done ? '✓' : number}
      </span>
      <span className="text-left leading-snug">{label}</span>
    </li>
  )
}

export function GithubAuthPanel({
  auth,
  authBusy,
  onConnect,
  onCancel,
  onOpenGithub
}: GithubAuthPanelProps) {
  const [copied, setCopied] = useState(false)
  const pending = Boolean(auth?.pending)
  const hasError = Boolean(auth?.error && !pending)
  const verificationUri = auth?.verificationUri ?? 'https://github.com/login/device'
  const userCode = auth?.userCode

  const handleCopyCode = (): void => {
    if (!userCode) return
    void copyText(userCode).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    })
  }

  if (hasError) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Icon name="pullRequest" size={28} className="mb-3 text-muted/50" />
        <p className="text-xs font-medium text-fg/80">GitHub authentication required</p>
        <p className="mt-2 max-w-[18rem] text-caption leading-relaxed text-danger [overflow-wrap:anywhere]">
          {auth?.error}
        </p>
        <div className="mt-4">
          <Button
            variant="subtle"
            className="h-7 px-2.5 text-caption"
            disabled={authBusy}
            onClick={onConnect}
          >
            Try again
          </Button>
        </div>
      </div>
    )
  }

  if (pending) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <Icon name="pullRequest" size={28} className="mb-3 text-muted/50" />
        <p className="text-xs font-medium text-fg/80">Signing in to GitHub</p>
        <p className="mt-1 max-w-[18rem] text-caption leading-relaxed text-muted">
          Complete authorization in your browser. Agent V will load your pull request when sign-in
          finishes.
        </p>

        <ol className="m-0 mt-4 w-full max-w-[18rem] list-none space-y-2 p-0 text-left">
          <AuthStep number={1} label="Open GitHub in your browser" active done />
          <AuthStep
            number={2}
            label={userCode ? 'Enter the one-time code on GitHub' : 'Sign in with your GitHub account'}
            active={!userCode}
            done={Boolean(userCode)}
          />
          <AuthStep number={3} label="Return here — Agent V detects sign-in automatically" active />
        </ol>

        {userCode ? (
          <div className="mt-4 w-full max-w-[18rem] rounded-md border border-border bg-surface px-3 py-2">
            <p className="m-0 text-2xs uppercase tracking-wide text-muted">One-time code</p>
            <div className="mt-1 flex items-center justify-center gap-2">
              <span className="font-mono text-lg font-semibold tracking-widest text-fg">
                {userCode}
              </span>
              <Button
                variant="subtle"
                className="h-7 px-2 text-caption"
                onClick={handleCopyCode}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="subtle"
            className="h-7 px-2.5 text-caption"
            onClick={() => onOpenGithub(verificationUri)}
          >
            Open GitHub
          </Button>
          <Button
            variant="subtle"
            className="h-7 px-2.5 text-caption"
            disabled={authBusy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>

        <div className="mt-4 flex items-center gap-2 text-caption text-muted">
          <Icon name="loader" size={14} className="motion-safe:animate-spin" />
          <span>Waiting for authorization…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Icon name="pullRequest" size={28} className="mb-3 text-muted/50" />
      <p className="text-xs font-medium text-fg/80">GitHub authentication required</p>
      <p className="mt-1 max-w-[16rem] text-caption leading-relaxed text-muted">
        Connect GitHub to view pull requests for this branch.
      </p>
      <div className="mt-3">
        <Button
          variant="subtle"
          className="h-7 px-2.5 text-caption"
          disabled={authBusy}
          onClick={onConnect}
        >
          {authBusy ? 'Starting…' : 'Connect GitHub'}
        </Button>
      </div>
    </div>
  )
}
