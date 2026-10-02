import { useEffect, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Keys } from '@renderer/lib/ui'
import { relRect, useRail } from './store'

/*
  Select any text in a record, a diff, a file or the terminal and a small
  "Ask about this" appears at the selection. It pins the exact lines to the
  lens — with where they came from — so the question never has to describe
  what you are looking at.
*/

type Found = { top: number; left: number; label: string; detail: string }

function lineOf(node: Node | null): number | null {
  const el = node instanceof Element ? node : node?.parentElement
  const hit = el?.closest('[data-line]')
  return hit ? Number(hit.getAttribute('data-line')) : null
}

export function SelectionAsk() {
  const { d, root } = useRail()
  const [found, setFound] = useState<Found | null>(null)

  useEffect(() => {
    const frame = root()
    if (!frame) return
    const read = (): void => {
      const sel = window.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (!sel || sel.rangeCount === 0 || text.length < 3) return setFound(null)
      const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
      const source = anchor?.closest('[data-ask-source]')
      if (!source || !frame.contains(source)) return setFound(null)
      const r = relRect(sel.getRangeAt(0).getBoundingClientRect(), frame)
      const a = lineOf(sel.anchorNode)
      const b = lineOf(sel.focusNode)
      const name = source.getAttribute('data-ask-source') ?? 'Selection'
      const lines = a && b ? ` L${Math.min(a, b)}${a !== b ? `–${Math.max(a, b)}` : ''}` : ''
      const first = text.split('\n')[0]
      setFound({
        top: Math.max(4, r.top - 38),
        left: Math.min(frame.offsetWidth - 230, Math.max(8, r.right - 190)),
        label: name + lines,
        detail: `“${first.length > 48 ? first.slice(0, 47) + '…' : first}”`
      })
    }
    const onUp = (): void => void setTimeout(read, 0)
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-selection-ask]')) setFound(null)
    }
    frame.addEventListener('pointerup', onUp)
    frame.addEventListener('pointerdown', onDown)
    frame.addEventListener('keyup', onUp)
    return () => {
      frame.removeEventListener('pointerup', onUp)
      frame.removeEventListener('pointerdown', onDown)
      frame.removeEventListener('keyup', onUp)
    }
  }, [root])

  useEffect(() => {
    if (!found) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        pin()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function pin(): void {
    if (!found) return
    d({ type: 'pin', item: { kind: 'quote', label: found.label, detail: found.detail } })
    d({ type: 'lens' })
    window.getSelection()?.removeAllRanges()
    setFound(null)
  }

  if (!found) return null
  return (
    <div data-selection-ask className="vy-menu absolute z-dropdown flex animate-menu-in items-center gap-1 p-1" style={{ top: found.top, left: found.left }}>
      <button
        type="button"
        onClick={pin}
        className="flex h-7 items-center gap-2 rounded-md px-2 text-xs font-medium text-fg-strong vy-transition hover:bg-surface focus-visible:vy-focus-ring"
      >
        <Icon name="at" size={13} className="text-accent" />
        Ask about this
        <Keys keys={['Alt', 'A']} />
      </button>
    </div>
  )
}
