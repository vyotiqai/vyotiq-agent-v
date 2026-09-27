import { useState } from 'react'
import { Button, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand'
import { copyText } from '@renderer/lib/markdown/copyText'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { GithubAuthStatus } from '@shared/ipc'
import { EmptyPanel } from './PanelChrome'

type GithubAuthPanelProps = {
  auth: GithubAuthStatus | null
  authBusy: boolean
  /** gh reports a sign-in but GitHub rejected it: offer a new one, not Connect. */
  rejected?: boolean
  onConnect: () => void
  onCancel: () => void
  onOpenGithub: (url: string) => void
}

/**
 * One step of the device flow. Each state is a shape before it is a colour:
 * done is a check, the step you are on is a filled disc, a later one an
 * outlined ring.
 */
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
        done ? 'text-muted' : active ? 'text-fg' : 'text-tertiary'
      )}
      aria-current={active && !done ? 'step' : undefined}
    >
      <span
        className={cn(
          'mt-px grid size-4 shrink-0 place-items-center rounded-full font-mono text-caption font-medium',
          done
            ? 'bg-success-soft text-success'
            : active
              ? 'bg-accent-soft text-accent'
              : 'border border-border text-tertiary'
        )}
        aria-hidden
      >
        {done ? <Icon name="check" size={10} weight="bold" /> : number}
      </span>
      <span className="leading-snug">
        {label}
        {done ? <span className="sr-only"> (done)</span> : null}
      </span>
    </li>
  )
}

export function GithubAuthPanel({
  auth,
  authBusy,
  rejected = false,
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
      <EmptyPanel
        icon="pullRequest"
        title="GitHub authentication required"
        body={<span className="text-danger [overflow-wrap:anywhere]">{auth?.error}</span>}
        actions={
          <Button size="sm" variant="primary" disabled={authBusy} onClick={onConnect}>
            Try again
          </Button>
        }
      />
    )
  }

  if (pending) {
    return (
      <EmptyPanel
        icon="pullRequest"
        title="Signing in to GitHub"
        body="Complete authorisation in your browser. Agent V will load your pull request when sign-in finishes."
        actions={
          <>
            <Button size="sm" variant="secondary" icon="external" onClick={() => onOpenGithub(verificationUri)}>
              Open GitHub
            </Button>
            <Button size="sm" variant="ghost" disabled={authBusy} onClick={onCancel}>
              Cancel
            </Button>
          </>
        }
      >
        <ol className="m-0 list-none space-y-2 p-0">
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
          <div className="mt-4">
            <p className={cn('m-0', SECTION_LABEL)}>One-time code</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-title font-semibold tracking-widest text-fg-strong">
                {userCode}
              </span>
              <Button size="sm" variant="secondary" icon={copied ? 'check' : 'copy'} onClick={handleCopyCode}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-2 text-caption text-muted" role="status">
          <AgentVSpinner size={14} />
          <span>Waiting for authorisation…</span>
        </div>
      </EmptyPanel>
    )
  }

  if (rejected) {
    return (
      <EmptyPanel
        icon="pullRequest"
        title="GitHub sign-in expired"
        body="GitHub turned down the saved sign-in. Sign in again to load pull requests for this branch."
        actions={
          <Button size="sm" variant="primary" disabled={authBusy} onClick={onConnect}>
            {authBusy ? 'Starting…' : 'Sign in again'}
          </Button>
        }
      />
    )
  }

  return (
    <EmptyPanel
      icon="pullRequest"
      title="GitHub authentication required"
      body="Connect GitHub to view pull requests for this branch."
      actions={
        <Button size="sm" variant="primary" disabled={authBusy} onClick={onConnect}>
          {authBusy ? 'Starting…' : 'Connect GitHub'}
        </Button>
      }
    />
  )
}
