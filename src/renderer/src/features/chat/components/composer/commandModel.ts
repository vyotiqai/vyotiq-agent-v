import type { ProviderIdAny } from '@shared/ipc'
import { parseModelSelectionKey } from '@shared/domain/modelSelection'
import type { ModelPickerOption } from './composerModelUtils'

export type CommandModelChoices = {
  /** The task's provider, searched first. */
  provider: ProviderIdAny
  /** Providers you have set up, in picker order. */
  providers: readonly ProviderIdAny[]
  optionsByProvider: Partial<Record<ProviderIdAny, ModelPickerOption[]>>
  seedsByProvider: Partial<Record<ProviderIdAny, ModelPickerOption[]>>
}

/** `GPT-4o (copilot)` → `gpt-4o`: Copilot names a model with its vendor after it. */
function normalize(name: string): string {
  return name
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
}

function modelId(option: ModelPickerOption): string {
  return (parseModelSelectionKey(option.value)?.model ?? option.value).toLowerCase()
}

/**
 * Which of your models a command file's `model:` means, as a `provider::model`
 * key, or null when none is. A full `provider::model` key is taken as is.
 * Otherwise each provider is tried, the task's first, so a model it also
 * serves keeps the task where it is: the model id itself, or after a router's
 * `vendor/` prefix, then the picker's name for it. Last, a word such as
 * `sonnet` when exactly one model of a provider carries it; a name that fits
 * several models of a provider settles nothing, so it is not guessed.
 */
export function matchCommandModel(written: string, choices: CommandModelChoices): string | null {
  const want = normalize(written)
  if (!want) return null
  const providers = [choices.provider, ...choices.providers.filter((p) => p !== choices.provider)]
  const optionsOf = (provider: ProviderIdAny): ModelPickerOption[] => {
    const live = choices.optionsByProvider[provider] ?? []
    // A placeholder seed's id is illustrative: it is not a model to switch to.
    return live.length ? live : (choices.seedsByProvider[provider] ?? []).filter((o) => !o.meta?.isPlaceholder)
  }

  const key = parseModelSelectionKey(written.trim())
  if (key && providers.includes(key.provider)) return `${key.provider}::${key.model}`

  const tests: ((option: ModelPickerOption) => boolean)[] = [
    (o) => modelId(o) === want,
    (o) => modelId(o).endsWith(`/${want}`),
    (o) => o.label.toLowerCase() === want
  ]
  for (const provider of providers) {
    for (const test of tests) {
      const hit = optionsOf(provider).find(test)
      if (hit) return hit.value
    }
  }

  if (/^[a-z0-9.-]+$/.test(want)) {
    const word = new RegExp(`(^|[^a-z0-9])${want.replace(/[.]/g, '\\.')}($|[^a-z0-9])`)
    for (const provider of providers) {
      const hits = optionsOf(provider).filter((o) => word.test(modelId(o)))
      if (hits.length === 1) return hits[0]!.value
    }
  }
  return null
}
