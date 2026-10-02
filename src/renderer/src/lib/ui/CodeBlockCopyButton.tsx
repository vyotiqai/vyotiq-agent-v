import { useEffect, useRef, useState } from 'react'
import { IconButton } from './IconButton'
import { copyText } from '@renderer/lib/markdown/copyText'
import { cn } from './cn'

/**
 * Copy with a word back: "Copied" for a moment, or "Copy failed". The state
 * a copy button shows, and the copy itself.
 */
export function useCopyFeedback(): { copied: boolean; copyError: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const timersRef = useRef<number[]>([])

  useEffect(() => {
    return () => {
      for (const id of timersRef.current) window.clearTimeout(id)
      timersRef.current = []
    }
  }, [])

  const clearTimers = (): void => {
    for (const id of timersRef.current) window.clearTimeout(id)
    timersRef.current = []
  }

  const schedule = (fn: () => void, ms: number): void => {
    const id = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((t) => t !== id)
      fn()
    }, ms)
    timersRef.current.push(id)
  }

  const copy = (text: string): void => {
    void copyText(text).then((ok) => {
      clearTimers()
      if (ok) {
        setCopied(true)
        setCopyError(false)
        schedule(() => setCopied(false), 1200)
      } else {
        setCopied(false)
        setCopyError(true)
        schedule(() => setCopyError(false), 1600)
      }
    })
  }

  return { copied, copyError, copy }
}

export function CodeBlockCopyButton({
  text,
  className
}: {
  text: string
  className?: string
}) {
  const { copied, copyError, copy } = useCopyFeedback()

  // The well's own colour behind the icon, so it never sits on a line of code;
  // the button keeps its muted tone and hover fill. No shadow: blocks are flush.
  return (
    <span
      className={cn(
        'absolute right-1 top-1 z-10 inline-grid rounded-sm bg-sunken vy-transition',
        // Always visible on coarse pointers; hover-reveal on fine pointers.
        'opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/code:opacity-100 [@media(hover:hover)]:group-focus-within/code:opacity-100',
        className
      )}
    >
      <IconButton
        icon={copied ? 'check' : 'copy'}
        label={copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy code'}
        size="xs"
        tone="muted"
        onClick={() => copy(text)}
      />
    </span>
  )
}
