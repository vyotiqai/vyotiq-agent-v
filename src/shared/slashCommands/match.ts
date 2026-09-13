import { normalizeTrigger, triggerKey } from './normalize'

export type SlashMatchable = {
  id: string
  trigger: string
  label: string
  description?: string
}

function orderedCharMatch(haystack: string, needle: string): boolean {
  let i = 0
  for (const ch of haystack) {
    if (ch === needle[i]) {
      i += 1
      if (i >= needle.length) return true
    }
  }
  return needle.length === 0
}

function scoreMatch(item: SlashMatchable, query: string): number {
  const q = normalizeTrigger(query)
  if (!q) return 1

  const trigger = normalizeTrigger(item.trigger)
  const label = item.label.toLowerCase()
  const description = (item.description ?? '').toLowerCase()
  const qKey = triggerKey(q)
  const tKey = triggerKey(trigger)

  if (trigger === q) return 100
  if (tKey === qKey && qKey.length > 0) return 95
  if (trigger.startsWith(q)) return 80
  if (tKey.startsWith(qKey) && qKey.length > 0) return 70
  if (trigger.includes(q)) return 60
  if (label.includes(q)) return 50
  if (description.includes(q)) return 40
  if (orderedCharMatch(tKey, qKey) && qKey.length > 0) return 30
  if (orderedCharMatch(label.replace(/[^a-z0-9]/g, ''), qKey) && qKey.length > 0) return 20
  return 0
}

/** Fuzzy-filter and rank slash commands by trigger, label, and description. */
export function fuzzyMatchCommands<T extends SlashMatchable>(query: string, items: T[]): T[] {
  const q = query.trim()
  if (!q || q === '/') return [...items]

  const scored = items
    .map((item) => ({ item, score: scoreMatch(item, q) }))
    .filter((row) => row.score > 0)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.item.trigger.localeCompare(b.item.trigger)
  })
  return scored.map((row) => row.item)
}

/**
 * Resolve a slash submit trigger to a command.
 * Exact match wins; otherwise prefer the active menu row when it is a prefix
 * expansion of the typed trigger; otherwise the top fuzzy hit when the typed
 * trigger is a prefix of that command's trigger.
 */
export function resolveSlashCommandForSubmit<T extends SlashMatchable>(
  typedTrigger: string,
  items: T[],
  activeCommand?: T | null
): T | null {
  const typedKey = triggerKey(typedTrigger)
  if (!typedKey) return null

  const exact = items.find((c) => triggerKey(c.trigger) === typedKey)
  if (exact) return exact

  if (activeCommand) {
    const activeKey = triggerKey(activeCommand.trigger)
    if (activeKey.startsWith(typedKey)) return activeCommand
  }

  const top = fuzzyMatchCommands(typedTrigger, items)[0]
  if (top && triggerKey(top.trigger).startsWith(typedKey)) return top
  return null
}
