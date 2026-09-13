function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false

  const previous = document.activeElement
  const selection = document.getSelection()
  const ranges: Range[] = []
  if (selection) {
    for (let i = 0; i < selection.rangeCount; i++) {
      ranges.push(selection.getRangeAt(i).cloneRange())
    }
  }

  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.setAttribute('aria-hidden', 'true')
  el.tabIndex = -1
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.left = '-9999px'
  el.style.opacity = '0'

  try {
    document.body.appendChild(el)
    el.focus()
    el.select()
    el.setSelectionRange(0, el.value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    el.remove()
    if (previous instanceof HTMLElement) previous.focus()
    if (selection && ranges.length > 0) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

export async function copyText(text: string): Promise<boolean> {
  const nativeWrite = typeof window !== 'undefined' ? window.vyotiq?.writeClipboard : undefined
  if (typeof nativeWrite === 'function') {
    try {
      if (nativeWrite(text)) return true
    } catch {
      // fall through
    }
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through
  }

  return copyViaExecCommand(text)
}
