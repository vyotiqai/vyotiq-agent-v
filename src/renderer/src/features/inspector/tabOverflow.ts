/**
 * Which inspector tabs fit on the strip, and which go to its "More panels"
 * menu. Tabs keep their order; the current tab always stays on the strip,
 * taking the place of the last ones that fit when it would not.
 */
export function fitTabs<T extends string>({
  ids,
  widthOf,
  available,
  gap,
  moreWidth,
  active
}: {
  ids: readonly T[]
  /** Each tab's measured width, in px. */
  widthOf: (id: T) => number
  /** The strip's width, in px. */
  available: number
  /** Space between two tabs, and between the last tab and the menu button. */
  gap: number
  /** The menu button's width. */
  moreWidth: number
  active: T
}): { visible: T[]; hidden: T[] } {
  const span = (list: readonly T[]): number =>
    list.reduce((sum, id, i) => sum + widthOf(id) + (i > 0 ? gap : 0), 0)
  if (span(ids) <= available) return { visible: [...ids], hidden: [] }

  const budget = available - moreWidth - gap
  const fitted: T[] = []
  for (const id of ids) {
    if (span([...fitted, id]) > budget) break
    fitted.push(id)
  }
  if (!fitted.includes(active)) {
    while (fitted.length > 0 && span([...fitted, active]) > budget) fitted.pop()
    fitted.push(active)
  }
  const visible = ids.filter((id) => fitted.includes(id))
  return { visible, hidden: ids.filter((id) => !fitted.includes(id)) }
}
