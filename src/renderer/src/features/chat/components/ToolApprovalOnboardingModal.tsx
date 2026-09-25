import { useId, useRef } from 'react'
import type { ToolApprovalMode } from '@shared/ipc'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Icon } from '@renderer/lib/icons'
import { Alert, Button } from '@renderer/lib/ui'
import { approvalModes } from '@renderer/features/setup/ApprovalModeChoice'

/**
 * The first send without an approval choice on record — someone who started a
 * task without finishing Set up. One click picks a mode and sends; Not now
 * sends nothing and asks again next time. The choice is the global one, as
 * Set up's is: it holds wherever a workspace doesn't set its own.
 */
export function ToolApprovalOnboardingModal({
  open,
  onChoose,
  onDismiss,
  error = null,
  mcpProtection = true
}: {
  open: boolean
  onChoose: (mode: ToolApprovalMode) => void
  onDismiss: () => void
  error?: string | null
  mcpProtection?: boolean
}) {
  const initialFocusRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descId = useId()

  return (
    <Dialog
      open={open}
      onClose={onDismiss}
      labelledBy={titleId}
      describedBy={descId}
      useNativeDialog={false}
      padded={false}
      initialFocusRef={initialFocusRef}
      className="vy-menu flex w-[440px] flex-col overflow-hidden"
    >
      <div data-approval-onboarding className="flex min-h-0 flex-col">
        <div className="px-5 pb-2 pt-5">
          <div className="flex items-center gap-2">
            <Icon name="shield" size={18} className="text-muted" />
            <h2 id={titleId} className="text-heading font-semibold text-fg-strong">
              What needs your OK?
            </h2>
          </div>
          <p id={descId} className="mt-2 text-sm leading-[21px] text-secondary">
            Choose once, before the first task starts. It holds in every workspace that doesn’t set its own, and
            Settings → Agent changes it later.
          </p>
        </div>
        {error ? (
          <div className="px-5 pt-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <div className="space-y-px px-3 pb-4 pt-2">
          {approvalModes(mcpProtection).map((item) => (
            <button
              key={item.mode}
              ref={item.mode === 'mutating' ? initialFocusRef : undefined}
              type="button"
              className="flex w-full flex-col rounded-md px-2 py-1.5 text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring"
              onClick={() => onChoose(item.mode)}
            >
              <span className="text-sm text-fg">{item.label}</span>
              <span className="text-xs text-muted">{item.description}</span>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center border-t border-border px-5 py-3">
          <span className="min-w-0 flex-1 text-caption text-tertiary">Not now keeps your brief, unsent.</span>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
