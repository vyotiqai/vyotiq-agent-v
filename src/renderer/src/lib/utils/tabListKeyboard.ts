import type { KeyboardEvent } from 'react'

export function handleTabListKeyDown(
  event: KeyboardEvent,
  opts: {
    tabs: string[]
    activeId: string | null
    onSelect: (id: string) => void
  }
): void {
  const { tabs, activeId, onSelect } = opts
  if (tabs.length === 0) return

  // activeId may be outside `tabs` (immersive Agent sessions replace the Agent chip).
  const found = tabs.findIndex((tab) => tab === activeId)
  let nextIndex = found

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = found === -1 ? 0 : (found + 1) % tabs.length
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = found === -1 ? tabs.length - 1 : (found - 1 + tabs.length) % tabs.length
  } else if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = tabs.length - 1
  } else {
    return
  }

  event.preventDefault()
  onSelect(tabs[nextIndex]!)
}
