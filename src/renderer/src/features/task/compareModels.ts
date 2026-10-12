import type { ProviderIdAny } from '@shared/ipc'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import type { ModelPickerOption } from '@renderer/features/chat/components/composer/composerModelUtils'

/** How many models "Also run on" offers: favorites and recent first, then each provider's suggestions. */
const COMPARE_OPTION_LIMIT = 12

export type CompareModelOption = { value: string; label: string; group: string }

/**
 * Models a new task can also run on, side by side with the one picked: your
 * favorites, then recent ones, then each ready provider's suggestions. The
 * model already picked is left out — comparing it with itself says nothing.
 */
export function compareModelOptions(input: {
  provider: ProviderIdAny
  model: string
  providers: readonly ProviderIdAny[]
  providerLabel: (id: ProviderIdAny) => string
  optionsByProvider: Partial<Record<ProviderIdAny, ModelPickerOption[]>>
  seedsByProvider?: Partial<Record<ProviderIdAny, ModelPickerOption[]>>
  favoriteModels?: readonly string[]
  recentModels?: readonly string[]
}): CompareModelOption[] {
  const current = modelSelectionKey(input.provider, input.model)
  const byKey = new Map<string, CompareModelOption>()
  for (const id of input.providers) {
    const group = input.providerLabel(id)
    for (const opt of input.optionsByProvider[id] ?? []) byKey.set(opt.value, { value: opt.value, label: opt.label, group })
  }
  const out: CompareModelOption[] = []
  const seen = new Set<string>([current])
  const take = (key: string): void => {
    const opt = byKey.get(key)
    if (!opt || seen.has(key) || out.length >= COMPARE_OPTION_LIMIT) return
    seen.add(key)
    out.push(opt)
  }
  input.favoriteModels?.forEach(take)
  input.recentModels?.forEach(take)
  for (const id of input.providers) {
    for (const seed of input.seedsByProvider?.[id] ?? []) take(seed.value)
  }
  // Nothing suggested: the picked provider's own list.
  if (out.length === 0) for (const opt of input.optionsByProvider[input.provider] ?? []) take(opt.value)
  return out
}
