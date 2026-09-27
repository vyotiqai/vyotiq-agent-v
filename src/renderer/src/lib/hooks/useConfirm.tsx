import { useCallback, useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button } from '@renderer/lib/ui/Button'

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
  const messageId = useId()
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

  // The rewind dialog's shape: title, the sentence under it in the quieter
  // weight, anything it lists, then the action row under a hairline.
  const dialog = (
    <Dialog
      open={state !== null}
      onClose={() => finish(false)}
      title={state?.title ?? 'Confirm action'}
      describedBy={messageId}
      useNativeDialog={false}
      className="vy-menu w-[min(92vw,28rem)] text-fg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button size="sm" variant={state?.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>
            {state?.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p id={messageId} className="m-0 text-sm leading-[21px] text-secondary">
          {state?.message}
        </p>
        {state?.details ? <div className="min-h-0">{state.details}</div> : null}
      </div>
    </Dialog>
  )

  return { confirm, dialog }
}
