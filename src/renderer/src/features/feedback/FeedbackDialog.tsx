import { useId, useRef, useState, type FormEvent } from 'react'
import { Dialog } from '@renderer/lib/a11y'
import { Button, Input, selectClass } from '@renderer/lib/ui'

export type FeedbackType = 'bug' | 'feature' | 'praise' | 'other'

export type FeedbackComposeInput = {
  type: FeedbackType
  title: string
  message: string
  includeDiagnostics: boolean
}

export type FeedbackComposeResult = {
  ok: boolean
  mailto: string
}

type FeedbackBridge = {
  feedback: {
    compose: (input: FeedbackComposeInput) => Promise<FeedbackComposeResult>
  }
}

/**
 * Read the feedback bridge off `window.vyotiq` without a hard compile-time
 * dependency on `VyotiqApi.feedback` landing in src/shared (main/preload
 * workstream owns that type). Tolerates both states; null means the bridge is
 * unavailable and the dialog falls back to the mailto link.
 */
function feedbackApi(): FeedbackBridge['feedback'] | null {
  const api = window.vyotiq as unknown as Partial<FeedbackBridge> | undefined
  return api?.feedback ?? null
}

const FEEDBACK_TYPES: Array<{ value: FeedbackType; label: string }> = [
  { value: 'bug', label: 'Bug report' },
  { value: 'feature', label: 'Feature request' },
  { value: 'praise', label: 'Praise' },
  { value: 'other', label: 'Other' }
]

const FEEDBACK_EMAIL = 'vyotiq@gmail.com'

/** Client-built fallback so feedback stays deliverable even without the bridge. */
function buildFallbackMailto(input: FeedbackComposeInput): string {
  const label = FEEDBACK_TYPES.find((t) => t.value === input.type)?.label ?? 'Feedback'
  const subject = `[Vyotiq] ${label}: ${input.title}`
  const body = `${input.message}\n\n(Feedback type: ${label})`
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

type Phase = 'idle' | 'sending' | 'success' | 'error'

export function FeedbackDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}) {
  const [type, setType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [mailto, setMailto] = useState<string | null>(null)

  const headerId = useId()
  const typeFieldId = useId()
  const titleFieldId = useId()
  const messageFieldId = useId()
  const diagnosticsFieldId = useId()

  const titleInputRef = useRef<HTMLInputElement>(null)

  const trimmedTitle = title.trim()
  const trimmedMessage = message.trim()
  const canSubmit = trimmedTitle.length > 0 && trimmedMessage.length > 0

  const close = (): void => {
    onClose()
    if (phase === 'success') {
      // Reset after a completed submission so reopening starts fresh.
      setType('bug')
      setTitle('')
      setMessage('')
      setIncludeDiagnostics(false)
    }
    setPhase('idle')
    setMailto(null)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!canSubmit || phase === 'sending') return
    const input: FeedbackComposeInput = {
      type,
      title: trimmedTitle,
      message: trimmedMessage,
      includeDiagnostics
    }
    setPhase('sending')
    const api = feedbackApi()
    if (!api) {
      setMailto(buildFallbackMailto(input))
      setPhase('error')
      return
    }
    void api
      .compose(input)
      .then((res) => {
        setMailto(res.ok ? res.mailto : (res.mailto || buildFallbackMailto(input)))
        setPhase(res.ok ? 'success' : 'error')
      })
      .catch(() => {
        setMailto(buildFallbackMailto(input))
        setPhase('error')
      })
  }

  const mailtoHref = mailto ?? buildFallbackMailto({
    type,
    title: trimmedTitle,
    message: trimmedMessage,
    includeDiagnostics
  })

  return (
    <Dialog open={open} onClose={close} labelledBy={headerId} initialFocusRef={titleInputRef}>
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={headerId} className="m-0 text-base font-medium text-fg-strong">
            Send feedback
          </h2>
          <button
            type="button"
            aria-label="Close feedback dialog"
            onClick={close}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted vy-transition hover:bg-surface-2 hover:text-fg focus-visible:vy-focus-ring"
          >
            ✕
          </button>
        </div>

        {phase === 'success' ? (
          <div className="flex flex-col gap-3" role="status">
            <p className="m-0 text-sm text-fg">
              Thanks — your email client should have opened with the message pre-filled.
              If it didn&apos;t, use the link below to open or copy it manually.
            </p>
            <a
              className="text-sm underline decoration-border underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring rounded-sm"
              href={mailtoHref}
            >
              Open email manually
            </a>
            <div className="flex justify-end">
              <Button variant="subtle" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : phase === 'error' ? (
          <div className="flex flex-col gap-3" role="alert">
            <p className="m-0 text-sm text-fg">
              We couldn&apos;t open your email client automatically. Your feedback is still
              deliverable — open the pre-filled email below and send it from your mail app.
            </p>
            <a
              className="text-sm underline decoration-border underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring rounded-sm"
              href={mailtoHref}
            >
              Open pre-filled email
            </a>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button variant="subtle" onClick={() => setPhase('idle')}>
                Back to form
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={typeFieldId} className="text-xs tracking-[var(--vy-tracking)] text-secondary">
                Type
              </label>
              <select
                id={typeFieldId}
                className={`${selectClass} w-full`}
                value={type}
                disabled={phase === 'sending'}
                onChange={(e) => {
                  setType(e.target.value as FeedbackType)
                }}
              >
                {FEEDBACK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={titleFieldId} className="text-xs tracking-[var(--vy-tracking)] text-secondary">
                Title
              </label>
              <Input
                id={titleFieldId}
                ref={titleInputRef}
                placeholder="Short summary"
                value={title}
                disabled={phase === 'sending'}
                onChange={(e) => {
                  setTitle(e.target.value)
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={messageFieldId} className="text-xs tracking-[var(--vy-tracking)] text-secondary">
                Message
              </label>
              <textarea
                id={messageFieldId}
                data-vy-text-entry
                rows={5}
                placeholder="What happened, or what would you like to see?"
                value={message}
                disabled={phase === 'sending'}
                onChange={(e) => {
                  setMessage(e.target.value)
                }}
                className="w-full rounded-md border border-border bg-surface px-[var(--vy-control-px)] py-2 text-sm leading-[1.4] text-fg placeholder:text-muted vy-transition hover:border-border-strong focus-visible:border-border-strong focus-visible:vy-focus-ring focus-visible:outline-none disabled:vy-disabled-state resize-y"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                id={diagnosticsFieldId}
                type="checkbox"
                className="size-4 shrink-0 accent-accent focus-visible:vy-focus-ring"
                checked={includeDiagnostics}
                disabled={phase === 'sending'}
                onChange={(e) => {
                  setIncludeDiagnostics(e.target.checked)
                }}
              />
              <label
                htmlFor={diagnosticsFieldId}
                className="text-xs leading-snug tracking-[var(--vy-tracking)] text-secondary"
              >
                Include basic diagnostics (app version, OS)
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={close} disabled={phase === 'sending'}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                pending={phase === 'sending'}
                disabled={!canSubmit}
                title={canSubmit ? undefined : 'Add a title and a message to send feedback'}
              >
                {phase === 'sending' ? 'Sending…' : 'Send feedback'}
              </Button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  )
}
