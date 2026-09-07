import { Button, Tooltip, cn } from '@renderer/lib/ui'

export function ActiveModelLink({
  model,
  onOpenComposer,
  onOpenProviders,
  disabled
}: {
  /** Provider · model label shown on the composer CTA. */
  model: string
  onOpenComposer?: () => void
  onOpenProviders?: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex w-full min-w-0 max-w-full items-center justify-end gap-2">
      <Tooltip content={model}>
        <button
          type="button"
          disabled={disabled || !onOpenComposer}
          className={cn(
            'min-w-0 max-w-full truncate rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-secondary vy-transition',
            onOpenProviders ? 'flex-1' : null,
            onOpenComposer
              ? 'hover:border-fg/30 hover:bg-surface-2 hover:text-fg'
              : 'cursor-default'
          )}
          onClick={() => onOpenComposer?.()}
        >
          {model}
        </button>
      </Tooltip>
      {onOpenProviders ? (
        <Button variant="subtle" className="shrink-0" disabled={disabled} onClick={onOpenProviders}>
          Open Providers
        </Button>
      ) : null}
    </div>
  )
}
