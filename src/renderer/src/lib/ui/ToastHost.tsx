import { useCallback, useState } from 'react'
import { cn } from './cn'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { StatusGlyph } from './StatusGlyph'
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type ToastItem,
  type ToastKind
} from './toastStore'

const KIND_ICON: Record<ToastKind, IconName> = {
  info: 'info',
  success: 'check',
  error: 'warning'
}

/** Only success and failure are coloured, and each keeps its own shape. */
const KIND_TONE: Record<ToastKind, string> = {
  info: 'text-muted',
  success: 'text-success',
  error: 'text-danger'
}

function ToastMark({ toast, size }: { toast: ToastItem; size: number }) {
  if (toast.state) return <StatusGlyph state={toast.state} size={size} />
  return <Icon name={toast.icon ?? KIND_ICON[toast.kind]} size={size} className={cn('shrink-0', KIND_TONE[toast.kind])} />
}

/** Time left before the toast goes; it stops while the pointer or focus is on the toast. */
function ToastTimer({ toast }: { toast: ToastItem }) {
  if (toast.durationMs <= 0) return null
  const paused = toast.expiresAt == null
  const left = Math.max(0, Math.min(1, toast.remainingMs / toast.durationMs))
  return (
    <div className="h-0.5 bg-border" aria-hidden="true">
      <div
        className="h-full origin-left bg-muted"
        style={{
          transform: `scaleX(${left})`,
          animation: paused ? undefined : `vy-toast-progress ${toast.remainingMs}ms linear forwards`
        }}
      />
    </div>
  )
}

/**
 * The toast stack, bottom right — mount once at the app root. A toast with a
 * detail or an action is a small card: its mark, a title over a quiet line,
 * the action, and the time it has left. Anything else is one line.
 */
export function ToastHost() {
  const toasts = useToasts()
  const [exiting, setExiting] = useState<ReadonlySet<number>>(() => new Set())

  const requestDismiss = useCallback((id: number) => {
    setExiting((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  if (toasts.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed bottom-[34px] right-3 z-toast flex w-[min(21.25rem,calc(100vw-1.5rem))] flex-col gap-2"
      aria-label="Notifications"
    >
      {toasts.map((toast) => {
        const rich = Boolean(toast.detail || toast.action)
        const dismiss = (
          <IconButton
            icon="close"
            label="Dismiss notification"
            size="xs"
            tone="muted"
            onClick={() => requestDismiss(toast.id)}
          />
        )
        return (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            data-toast={rich ? 'card' : 'line'}
            className={cn(
              'vy-menu pointer-events-auto overflow-hidden',
              exiting.has(toast.id) ? 'animate-toast-out' : 'animate-toast-in'
            )}
            onAnimationEnd={() => {
              if (exiting.has(toast.id)) dismissToast(toast.id)
            }}
            onPointerEnter={() => pauseToast(toast.id)}
            onPointerLeave={() => resumeToast(toast.id)}
            onFocus={() => pauseToast(toast.id)}
            onBlur={() => resumeToast(toast.id)}
          >
            {rich ? (
              <>
                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  <span className="mt-0.5 flex shrink-0">
                    <ToastMark toast={toast} size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-sm font-medium text-fg-strong">{toast.message}</div>
                    {toast.detail ? <div className="truncate text-xs text-muted">{toast.detail}</div> : null}
                  </div>
                  {toast.action ? (
                    <Button
                      size="xs"
                      onClick={() => {
                        toast.action?.onClick()
                        requestDismiss(toast.id)
                      }}
                    >
                      {toast.action.label}
                    </Button>
                  ) : null}
                  {dismiss}
                </div>
                <ToastTimer toast={toast} />
              </>
            ) : (
              <div className="flex items-center gap-2.5 px-3 py-2">
                <ToastMark toast={toast} size={14} />
                {toast.onClick ? (
                  <button
                    type="button"
                    className="min-w-0 flex-1 break-words rounded-sm text-left text-sm text-fg vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
                    onClick={() => {
                      toast.onClick?.()
                      requestDismiss(toast.id)
                    }}
                  >
                    {toast.message}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 break-words text-sm text-fg">{toast.message}</span>
                )}
                {dismiss}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
