import { useCallback, useState } from 'react'
import { cn } from './cn'
import { Icon } from '@renderer/lib/icons'
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type ToastItem,
  type ToastKind
} from './toastStore'

const KIND_CLASSES: Record<ToastKind, string> = {
  info: 'border-border bg-surface text-fg',
  success: 'border-success/40 bg-surface text-fg',
  error: 'border-danger/50 bg-surface text-fg'
}

const KIND_ICON: Record<ToastKind, 'check' | 'warning' | 'sparkles'> = {
  info: 'sparkles',
  success: 'check',
  error: 'warning'
}

function ToastProgress({ toast }: { toast: ToastItem }) {
  if (toast.durationMs <= 0) return null
  const paused = toast.expiresAt == null
  const remainingMs = toast.remainingMs
  const startFraction = Math.max(0, Math.min(1, remainingMs / toast.durationMs))
  return (
    <div
      className="pointer-events-none absolute bottom-0 left-0 h-0.5 w-full origin-left bg-current opacity-30"
      style={{
        transform: `scaleX(${startFraction})`,
        animation: paused ? undefined : `vy-toast-progress ${remainingMs}ms linear forwards`
      }}
      aria-hidden="true"
    />
  )
}

/** Fixed bottom-right toast stack — mount once at the app root. */
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
      className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={cn(
            'pointer-events-auto relative flex items-start gap-2 overflow-hidden rounded-md border px-3 py-2 text-xs shadow-menu',
            KIND_CLASSES[toast.kind],
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
          <Icon
            name={KIND_ICON[toast.kind]}
            size={14}
            className={cn(
              'mt-0.5 shrink-0',
              toast.kind === 'error' ? 'text-danger' : toast.kind === 'success' ? 'text-success' : 'text-tertiary'
            )}
          />
          {toast.onClick ? (
            <button
              type="button"
              className="min-w-0 flex-1 text-left leading-snug [overflow-wrap:anywhere] vy-transition hover:text-fg-strong"
              onClick={() => {
                toast.onClick?.()
                requestDismiss(toast.id)
              }}
            >
              {toast.message}
            </button>
          ) : (
            <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">
              {toast.message}
            </span>
          )}
          <button
            type="button"
            aria-label="Dismiss notification"
            className="shrink-0 rounded-sm p-0.5 text-tertiary vy-transition hover:text-fg"
            onClick={() => requestDismiss(toast.id)}
          >
            <Icon name="close" size={12} />
          </button>
          <ToastProgress toast={toast} />
        </div>
      ))}
    </div>
  )
}
