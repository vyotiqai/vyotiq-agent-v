import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { FEEDBACK_MESSAGE_MAX, FEEDBACK_TITLE_MAX } from '@shared/ipc'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { copyText } from '@renderer/lib/markdown/copyText'
import { Button, Checkbox, Input, Segmented, Textarea } from '@renderer/lib/ui'
import { exportDiagnosticsBundle, type DiagnosticsExportOutcome } from './exportDiagnostics'

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

/**
 * Bridge result — the real preload returns an `IpcResult` envelope
 * (`{ok:true,data}` | `{ok:false,error}`); the inner data carries the compose
 * result. `mailto` is accepted at the top level too so the dialog degrades
 * gracefully if the envelope ever changes shape.
 */
type FeedbackBridgeReply = {
  ok: boolean
  data?: FeedbackComposeResult
  mailto?: string
}

type FeedbackBridge = {
  feedback: {
    compose: (input: FeedbackComposeInput) => Promise<FeedbackBridgeReply>
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

const FEEDBACK_EMAIL = 'support@vyotiq.com'

const FIELD_LABEL = 'block text-xs font-medium text-fg'

/** Characters used against the limit: a number, so mono and tabular. */
const COUNTER = 'm-0 text-right font-mono text-caption text-tertiary tnum'

/** Input size="sm"'s chrome, as a textarea: one focus treatment, the ring. */
const MAIL_LINK =
  'rounded-sm text-xs text-secondary underline decoration-border underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring'

/** Plain-text subject/body of the pre-filled email (shared by mailto + copy). */
function buildFeedbackText(input: FeedbackComposeInput): { subject: string; body: string } {
  const label = FEEDBACK_TYPES.find((t) => t.value === input.type)?.label ?? 'Feedback'
  return {
    subject: `[Vyotiq] ${label}: ${input.title}`,
    body: `${input.message}\n\n(Feedback type: ${label})`
  }
}

/** Client-built fallback so feedback stays deliverable even without the bridge. */
function buildFallbackMailto(input: FeedbackComposeInput): string {
  const { subject, body } = buildFeedbackText(input)
  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/**
 * Normalize a bridge reply into the compose result. The preload wraps the
 * result in the `IpcResult` envelope (`{ok:true,data}`), while older bridge
 * mocks return a flat `{ok,mailto}` — tolerate both so a shape change can
 * never drop the main-composed mailto (which carries the diagnostics block).
 */
function unwrapComposeReply(res: FeedbackBridgeReply): FeedbackComposeResult {
  const data = res.data
  if (data && typeof data.mailto === 'string') {
    return { ok: res.ok && data.ok !== false, mailto: data.mailto }
  }
  return { ok: Boolean(res.ok), mailto: res.mailto ?? '' }
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
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportOutcome, setExportOutcome] = useState<DiagnosticsExportOutcome | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  /** A mailto can't carry a file: save the redacted bundle for the person to attach. */
  const exportBundle = (): void => {
    setExporting(true)
    void exportDiagnosticsBundle()
      .then((outcome) => {
        if (outcome.kind !== 'canceled') setExportOutcome(outcome)
      })
      .finally(() => setExporting(false))
  }

  const formId = useId()
  const titleFieldId = useId()
  const messageFieldId = useId()

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
    setCopied(false)
    setExportOutcome(null)
  }

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
    },
    []
  )

  const copyEmailText = (): void => {
    const input: FeedbackComposeInput = {
      type,
      title: trimmedTitle,
      message: trimmedMessage,
      includeDiagnostics
    }
    const { subject, body } = buildFeedbackText(input)
    void copyText(`${subject}\n\n${body}`).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1600)
    })
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
        const compose = unwrapComposeReply(res)
        const mailtoHref = compose.mailto || buildFallbackMailto(input)
        setMailto(mailtoHref)
        setPhase(compose.ok ? 'success' : 'error')
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

  const locked = phase === 'sending'

  // The action row changes with the phase; the form's submit sits in it, so it
  // names the form it belongs to.
  const footer =
    phase === 'success' ? (
      <Button size="sm" variant="secondary" onClick={close}>
        Done
      </Button>
    ) : phase === 'error' ? (
      <>
        <Button size="sm" variant="ghost" onClick={close}>
          Close
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setPhase('idle')}>
          Back to form
        </Button>
      </>
    ) : (
      <>
        <Button
          size="sm"
          variant="ghost"
          icon="download"
          className="mr-auto"
          pending={exporting}
          disabled={locked}
          onClick={exportBundle}
        >
          {exporting ? 'Exporting…' : 'Export diagnostics'}
        </Button>
        <Button size="sm" variant="ghost" onClick={close} disabled={locked}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          size="sm"
          variant="primary"
          pending={locked}
          disabled={!canSubmit}
          title={canSubmit ? undefined : 'Add a title and a message to send feedback'}
        >
          {locked ? 'Sending…' : 'Send feedback'}
        </Button>
      </>
    )

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Send feedback"
      icon="note"
      useNativeDialog={false}
      padded={false}
      initialFocusRef={titleInputRef}
      className="vy-menu flex w-[480px] flex-col overflow-hidden"
      footer={footer}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {phase === 'success' ? (
          <div className="space-y-3" role="status">
            <p className="m-0 text-sm text-fg">
              Thanks — your email client should have opened with the message pre-filled.
              If it didn&apos;t, use the link below to open or copy it manually.
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <a className={MAIL_LINK} href={mailtoHref}>
                Open email manually
              </a>
              <Button size="sm" variant="ghost" onClick={copyEmailText}>
                {copied ? 'Copied' : 'Copy message'}
              </Button>
            </div>
          </div>
        ) : phase === 'error' ? (
          <div className="space-y-3" role="alert">
            <p className="m-0 text-sm text-fg">
              We couldn&apos;t open your email client automatically. Your feedback is still
              deliverable — open the pre-filled email below and send it from your mail app.
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <a className={MAIL_LINK} href={mailtoHref}>
                Open pre-filled email
              </a>
              <Button size="sm" variant="ghost" onClick={copyEmailText}>
                {copied ? 'Copied' : 'Copy message'}
              </Button>
            </div>
          </div>
        ) : (
          <form id={formId} className="space-y-4" onSubmit={handleSubmit} noValidate>
            <div className="space-y-1.5">
              <span className={FIELD_LABEL} aria-hidden>
                Type
              </span>
              <div>
                <Segmented
                  label="Type"
                  value={type}
                  items={FEEDBACK_TYPES.map((t) => ({ id: t.value, label: t.label }))}
                  disabled={locked}
                  onChange={setType}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={titleFieldId} className={FIELD_LABEL}>
                Title
              </label>
              <Input
                id={titleFieldId}
                ref={titleInputRef}
                size="sm"
                placeholder="Short summary"
                value={title}
                maxLength={FEEDBACK_TITLE_MAX}
                disabled={locked}
                onChange={(e) => {
                  setTitle(e.target.value)
                }}
              />
              <p className={COUNTER} aria-hidden>
                {trimmedTitle.length}/{FEEDBACK_TITLE_MAX}
              </p>
            </div>

            <div className="space-y-1.5">
              <label htmlFor={messageFieldId} className={FIELD_LABEL}>
                Message
              </label>
              <Textarea
                id={messageFieldId}
                size="sm"
                rows={5}
                placeholder="What happened, or what would you like to see?"
                value={message}
                maxLength={FEEDBACK_MESSAGE_MAX}
                disabled={locked}
                onChange={(e) => {
                  setMessage(e.target.value)
                }}
              />
              <p className={COUNTER} aria-hidden>
                {trimmedMessage.length}/{FEEDBACK_MESSAGE_MAX}
              </p>
            </div>

            <Checkbox
              checked={includeDiagnostics}
              disabled={locked}
              onCheckedChange={setIncludeDiagnostics}
              label="Include basic diagnostics (app version, OS)"
            />
            {exportOutcome?.kind === 'saved' ? (
              <p className="m-0 text-xs text-secondary" role="status">
                Saved {exportOutcome.fileName}. Attach it to the email.
              </p>
            ) : exportOutcome?.kind === 'error' ? (
              <p className="m-0 text-xs text-danger" role="alert">
                {exportOutcome.message}
              </p>
            ) : null}
          </form>
        )}
      </div>
    </Dialog>
  )
}
