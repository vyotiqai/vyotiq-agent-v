import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'

type ConfirmState = {
  message: string
  /** Optional rich content (e.g. the file list a revert will restore). */
  details?: ReactNode
  title: string
  confirmLabel: string
  danger: boolean
}

export function useConfirm(): {
  confirm: (
    message: string,
    options?: Partial<Omit<ConfirmState, 'message'>>
  ) => Promise<boolean>
  dialog: JSX.Element
} {
  const [state, setState] = useState<ConfirmState | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const finish = useCallback((value: boolean): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setState(null)
    resolve?.(value)
  }, [])

  const confirm = useCallback(
    (
      message: string,
      options: Partial<Omit<ConfirmState, 'message'>> = {}
    ): Promise<boolean> => {
      resolverRef.current?.(false)
      resolverRef.current = null
      setState({
        message,
        ...(options.details ? { details: options.details } : {}),
        title: options.title ?? 'Confirm action',
        confirmLabel: options.confirmLabel ?? 'Confirm',
        danger: options.danger ?? false
      })
      return new Promise<boolean>((resolve) => {
        resolverRef.current = resolve
      })
    },
    []
  )

  useEffect(
    () => () => {
      resolverRef.current?.(false)
      resolverRef.current = null
    },
    []
  )

  const dialog = (
    <Dialog
      open={state !== null}
      onClose={() => finish(false)}
      title={state?.title ?? 'Confirm action'}
      useNativeDialog={false}
      className="w-[min(92vw,28rem)] rounded-xl border border-border bg-surface p-4 text-fg shadow-xl"
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg">{state?.message}</p>
        {state?.details ? <div className="min-h-0">{state.details}</div> : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
            onClick={() => finish(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            className={
              state?.danger
                ? 'rounded-md bg-danger px-3 py-1.5 text-xs text-white hover:opacity-90'
                : 'rounded-md bg-accent px-3 py-1.5 text-xs text-accent-fg hover:bg-accent/90'
            }
            onClick={() => finish(true)}
          >
            {state?.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </Dialog>
  )

  return { confirm, dialog }
}
