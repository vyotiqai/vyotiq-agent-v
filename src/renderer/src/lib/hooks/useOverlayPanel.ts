import { useEffect } from 'react'
import type { RefObject } from 'react'
import { useFocusTrap } from '@renderer/lib/a11y'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'

export function useOverlayPanel({
  open,
  onClose,
  panelRef,
  inertTargetRef,
  restoreFocusRef
}: {
  open: boolean
  onClose: () => void
  panelRef: RefObject<HTMLElement | null>
  inertTargetRef?: RefObject<HTMLElement | null>
  restoreFocusRef?: RefObject<HTMLElement | null>
}): void {
  useEscapeToClose(onClose, open, { capture: true })

  useFocusTrap({
    active: open,
    containerRef: panelRef,
    returnFocusRef: restoreFocusRef
  })

  useEffect(() => {
    if (!open) return
    const target = inertTargetRef?.current
    if (target) target.setAttribute('inert', '')
    panelRef.current?.focus()

    return () => {
      if (target) target.removeAttribute('inert')
    }
  }, [open, inertTargetRef, panelRef])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      if (panel.contains(event.target as Node)) return
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, onClose, panelRef])
}
