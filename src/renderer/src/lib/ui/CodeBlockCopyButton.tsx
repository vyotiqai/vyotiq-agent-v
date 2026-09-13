import { useEffect, useRef, useState } from 'react'
import { IconButton } from './IconButton'
import { copyText } from '@renderer/lib/markdown/copyText'
import { cn } from './cn'

export function CodeBlockCopyButton({
  text,
  className
}: {
  text: string
  className?: string
}) {
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

  return (
    <IconButton
      icon={copied ? 'check' : 'copy'}
      label={copied ? 'Copied' : copyError ? 'Copy failed' : 'Copy code'}
      size="xs"
      variant="subtle"
      className={cn(
        // Always visible on coarse pointers; hover-reveal on fine pointers.
        'absolute right-1 top-1 z-10 bg-surface/90 shadow-sm vy-transition',
        'opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/code:opacity-100 [@media(hover:hover)]:group-focus-within/code:opacity-100',
        className
      )}
      onClick={() => {
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
      }}
    />
  )
}
