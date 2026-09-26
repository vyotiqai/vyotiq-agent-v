import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, Input } from '@renderer/lib/ui'

type PromptOptions = {
  /** The verb on the submit button, when "OK" says less than it could ("Create", "Rename"). */
  confirmLabel?: string
}

type PromptState = {
  message: string
  value: string
  confirmLabel: string
}

export function usePrompt(): {
  prompt: (message: string, defaultValue?: string, options?: PromptOptions) => Promise<string | null>
  dialog: JSX.Element
} {
  const [state, setState] = useState<PromptState | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolverRef = useRef<((value: string | null) => void) | null>(null)
  const formId = useId()

  const finish = useCallback((value: string | null): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setState(null)
    resolve?.(value)
  }, [])

  const prompt = useCallback(
    (message: string, defaultValue = '', options: PromptOptions = {}): Promise<string | null> => {
      resolverRef.current?.(null)
      resolverRef.current = null
      setState({ message, value: defaultValue, confirmLabel: options.confirmLabel ?? 'OK' })
      return new Promise<string | null>((resolve) => {
        resolverRef.current = resolve
      })
    },
    []
  )

  useEffect(
    () => () => {
      resolverRef.current?.(null)
      resolverRef.current = null
    },
    []
  )

  // The question is the dialog's title, so it reads as one — not as a field
  // label floating over an input. The action row sits outside the form, so the
  // submit button names the form it belongs to.
  const dialog = (
    <Dialog
      open={state !== null}
      onClose={() => finish(null)}
      title={state?.message ?? 'Input'}
      initialFocusRef={inputRef}
      useNativeDialog={false}
      className="vy-menu w-[min(92vw,28rem)] text-fg"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} size="sm" variant="primary">
            {state?.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault()
          finish(state?.value ?? '')
        }}
      >
        <Input
          ref={inputRef}
          size="sm"
          aria-label="Prompt input"
          value={state?.value ?? ''}
          onChange={(event) =>
            setState((current) => (current ? { ...current, value: event.target.value } : current))
          }
        />
      </form>
    </Dialog>
  )

  return { prompt, dialog }
}
