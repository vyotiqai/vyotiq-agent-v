import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { Dialog } from '@renderer/lib/a11y/Dialog'

type PromptState = {
  message: string
  value: string
}

export function usePrompt(): {
  prompt: (message: string, defaultValue?: string) => Promise<string | null>
  dialog: JSX.Element
} {
  const [state, setState] = useState<PromptState | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const resolverRef = useRef<((value: string | null) => void) | null>(null)

  const finish = useCallback((value: string | null): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setState(null)
    resolve?.(value)
  }, [])

  const prompt = useCallback(
    (message: string, defaultValue = ''): Promise<string | null> => {
      resolverRef.current?.(null)
      resolverRef.current = null
      setState({ message, value: defaultValue })
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

  const dialog = (
    <Dialog
      open={state !== null}
      onClose={() => finish(null)}
      title={state?.message ?? 'Input'}
      initialFocusRef={inputRef}
      useNativeDialog={false}
      className="w-[min(92vw,28rem)] rounded-xl border border-border bg-surface p-4 text-fg shadow-xl"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          finish(state?.value ?? '')
        }}
      >
        <label className="text-xs text-fg" htmlFor="vyotiq-prompt-input">
          {state?.message}
        </label>
        <input
          ref={inputRef}
          id="vyotiq-prompt-input"
          aria-label="Prompt input"
          className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm outline-none focus-visible:vy-focus-ring"
          value={state?.value ?? ''}
          onChange={(event) =>
            setState((current) => (current ? { ...current, value: event.target.value } : current))
          }
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2"
            onClick={() => finish(null)}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-accent-fg hover:bg-accent/90"
          >
            OK
          </button>
        </div>
      </form>
    </Dialog>
  )

  return { prompt, dialog }
}
