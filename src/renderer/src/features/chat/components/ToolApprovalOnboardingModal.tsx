import { useId, useRef } from 'react'
import type { ToolApprovalMode } from '@shared/ipc'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Alert, Button } from '@renderer/lib/ui'

const MODES: {
  mode: ToolApprovalMode
  label: string
  description: string
  recommended?: boolean
}[] = [
  {
    mode: 'mutating',
    label: 'Mutating tools',
    description: 'Ask before file edits, terminal, and other changes. Reads can run without asking.',
    recommended: true
  },
  {
    mode: 'off',
    label: 'Off',
    description: 'Run tools without asking. Faster; riskier on unfamiliar repos.'
  },
  {
    mode: 'all',
    label: 'All tools',
    description: 'Ask before every tool, including reads. Maximum control; more interruptions.'
  }
]

export function ToolApprovalOnboardingModal({
  open,
  onChoose,
  onDismiss,
  error = null
}: {
  open: boolean
  onChoose: (mode: ToolApprovalMode) => void
  onDismiss: () => void
  error?: string | null
}) {
  const titleId = useId()
  const descId = useId()
  const initialFocusRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog
      open={open}
      onClose={onDismiss}
      labelledBy={titleId}
      describedBy={descId}
      initialFocusRef={initialFocusRef}
      useNativeDialog
    >
      <div className="flex flex-col gap-3 p-5">
        <div>
          <h2 id={titleId} className="m-0 text-md font-semibold text-fg-strong">
            Tool approval
          </h2>
          <p id={descId} className="m-0 mt-1 text-sm text-secondary">
            Choose when Agent V should ask before running tools on this workspace. You can change
            this anytime in Settings → Tools.
          </p>
        </div>
        {error ? <Alert>{error}</Alert> : null}
        <div className="flex flex-col gap-2">
          {MODES.map((item) => (
            <button
              key={item.mode}
              ref={item.mode === 'mutating' ? initialFocusRef : undefined}
              type="button"
              className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface"
              onClick={() => onChoose(item.mode)}
            >
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium text-fg-strong">{item.label}</div>
                {item.recommended ? (
                  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                    Recommended
                  </span>
                ) : null}
              </div>
              <div className="text-xs text-secondary">{item.description}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="subtle" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
