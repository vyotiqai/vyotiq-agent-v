import { useEffect, useState, type RefObject } from 'react'
import type { ViewSpec } from '@shared/viewSpec'

/*
  Which copy of a view is the current one. Every ```view fence that names an
  id registers its element; within one record (one `[data-chat-pane]`), the
  copy furthest down is current and the earlier ones fold to a line. The
  last settled spec per id is kept too, per task, so a reply that reshapes a
  view can start from what the earlier copy showed — even once that copy has
  folded into History and unmounted. Another task's view of the same id is
  never a starting point: its rows would fold away inside this one.
*/

const mounted = new Map<string, Set<HTMLElement>>()
const listeners = new Set<() => void>()
const settledSpecs = new Map<string, ViewSpec>()

function notify(): void {
  for (const l of listeners) l()
}

const paneOf = (el: HTMLElement): Element => el.closest('[data-chat-pane]') ?? el.ownerDocument.body

function hasLaterCopy(id: string, el: HTMLElement): boolean {
  const pane = paneOf(el)
  for (const other of mounted.get(id) ?? []) {
    if (other === el || !other.isConnected || paneOf(other) !== pane) continue
    if (el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return true
  }
  return false
}

/** True while a later reply in the same record shows a newer copy of this view. */
export function useLaterCopy(id: string | undefined, ref: RefObject<HTMLElement | null>): boolean {
  const [later, setLater] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!id || !el) return
    let set = mounted.get(id)
    if (!set) mounted.set(id, (set = new Set()))
    set.add(el)
    const check = (): void => setLater(hasLaterCopy(id, el))
    listeners.add(check)
    notify()
    return () => {
      listeners.delete(check)
      set.delete(el)
      if (set.size === 0) mounted.delete(id)
      notify()
    }
  }, [id, ref])
  return later
}

/** Which task a view belongs to: its workspace and run. */
export const viewScope = (workspacePath: string | null, runId: string | null): string => `${workspacePath ?? ''}\u0000${runId ?? ''}`

const scoped = (scope: string, id: string): string => `${scope}\u0001${id}`

/** What the newest settled copy of this view in this task showed, if any. */
export function settledSpec(scope: string, id: string): ViewSpec | null {
  return settledSpecs.get(scoped(scope, id)) ?? null
}

/** Views are few; the cap only keeps a long session from holding every one it ever drew. */
const SETTLED_MAX = 100

export function rememberSettled(scope: string, spec: ViewSpec): void {
  const k = scoped(scope, spec.id)
  settledSpecs.delete(k)
  settledSpecs.set(k, spec)
  if (settledSpecs.size > SETTLED_MAX) settledSpecs.delete(settledSpecs.keys().next().value!)
}
