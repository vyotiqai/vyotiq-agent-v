import { useId, type ReactNode, type RefObject } from 'react'
import { Keys } from '@renderer/lib/ui'

/** git refuses nothing shorter; main's request schema caps the message here. */
const MESSAGE_MAX = 2000

function modKey(): string {
  return typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin' ? '⌘' : 'Ctrl'
}

/**
 * The commit message as git takes it: a title line, then a blank line and the
 * body. Enter starts a new line; Ctrl+Enter commits; Esc drops the commit and
 * nothing else. Under it, what the commit is: where it goes, how many files,
 * and whether the words are the agent's draft or yours.
 */
export function CommitMessageField({
  value,
  onChange,
  onSubmit,
  onCancel,
  fieldRef,
  generating,
  canSubmit,
  branch,
  files,
  note
}: {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  fieldRef?: RefObject<HTMLTextAreaElement | null>
  /** The agent is writing the message. */
  generating: boolean
  /** A message and nothing busy: Ctrl+Enter commits. */
  canSubmit: boolean
  /** The branch the commit lands on, when there is one. */
  branch: string | null
  /** How many files the commit takes. */
  files: number
  /** Where the words came from, or why they may be wrong. */
  note?: ReactNode
}) {
  const factsId = useId()
  return (
    <div className="min-w-0 space-y-1.5" data-commit-message>
      <textarea
        ref={fieldRef}
        value={value}
        rows={1}
        maxLength={MESSAGE_MAX}
        spellCheck={false}
        // Grows with its lines up to a few, then scrolls.
        className="block max-h-40 w-full resize-none rounded-sm bg-transparent font-mono text-xs leading-5 text-fg outline-none [field-sizing:content] placeholder:font-sans placeholder:text-tertiary focus-visible:vy-focus-ring"
        placeholder={generating ? 'The agent is writing a commit message…' : 'Commit message'}
        aria-label="Commit message"
        aria-describedby={factsId}
        title="Commit message, written by the agent — edit it here"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            if (canSubmit) onSubmit()
            return
          }
          if (e.key === 'Escape') {
            // Esc here cancels the commit only — never the running agent.
            e.preventDefault()
            e.stopPropagation()
            onCancel()
          }
        }}
      />
      <p
        id={factsId}
        className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-caption text-tertiary"
        data-commit-facts
      >
        <span className="min-w-0 truncate">
          {branch ? (
            <>
              Commit to <code className="font-mono text-muted">{branch}</code> ·{' '}
            </>
          ) : null}
          {files} {files === 1 ? 'file' : 'files'}
        </span>
        {note ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate" aria-live="polite">
              {note}
            </span>
          </>
        ) : null}
        <span className="flex-1" />
        <Keys keys={[modKey(), '↵']} />
      </p>
    </div>
  )
}
