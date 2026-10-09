import { useState, type JSX } from 'react'
import { MAX_CUSTOM_MODEL_PRICES, type CustomModelPriceSetting } from '@shared/ipc'
import { PROVIDER_DEFAULTS, providerLabel } from '@shared/domain/providers'
import { Button, IconButton, Input, Menu, cn, selectTriggerClass } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import { SettingsField, SettingsItem } from './SettingsField'

const ANY_PROVIDER = '*'

function money(n: number): string {
  return `$${Number.isInteger(n) ? n : n.toFixed(n < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '')}`
}

/** "In $3 · Out $15 · Cached $0.3 per 1M tokens" */
export function priceLine(p: CustomModelPriceSetting): string {
  const parts = [`In ${money(p.input)}`, `Out ${money(p.output)}`]
  if (p.cachedInput !== undefined) parts.push(`Cached ${money(p.cachedInput)}`)
  return `${parts.join(' · ')} per 1M tokens`
}

function parseRate(raw: string): number | null {
  const text = raw.trim().replace(/^\$/, '')
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 && n <= 100_000 ? n : null
}

/**
 * Prices set by hand: one row per model, and an add row under them. They win
 * over the built-in table and the models.dev catalog, so a custom endpoint, a
 * negotiated rate or a model newer than the app gets a cost — and counts
 * toward the spend limit and budgets.
 */
export function CustomPricesField({ form }: { form: SettingsFormState }): JSX.Element {
  const prices = form.settings.customModelPrices ?? []
  const customProviders = form.settings.customProviders ?? []
  const [provider, setProvider] = useState<string>(form.settings.provider ?? ANY_PROVIDER)
  const [model, setModel] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [cached, setCached] = useState('')
  const [error, setError] = useState<string | null>(null)

  const providerOptions = [
    { value: ANY_PROVIDER, label: 'Any provider' },
    ...PROVIDER_DEFAULTS.map((p) => ({ value: p.id, label: p.label })),
    ...customProviders.map((p) => ({ value: p.id, label: p.name.trim() || 'Custom' }))
  ]
  const labelOf = (id: string): string =>
    id === ANY_PROVIDER ? 'Any provider' : providerLabel(id as Parameters<typeof providerLabel>[0], customProviders)

  const save = (next: CustomModelPriceSetting[]): void => {
    void form.runUpdate({ customModelPrices: next })
  }

  const add = (): void => {
    const id = model.trim()
    const inRate = parseRate(input)
    const outRate = parseRate(output)
    const cachedRate = cached.trim() ? parseRate(cached) : undefined
    if (!id) return setError('Name the model: its id, or a prefix ending in *.')
    if (inRate === null || outRate === null) return setError('Input and output need a price in dollars per 1M tokens.')
    if (cachedRate === null) return setError('The cached price is a number of dollars per 1M tokens, or empty.')
    const entry: CustomModelPriceSetting = {
      provider,
      model: id,
      input: inRate,
      output: outRate,
      ...(cachedRate !== undefined ? { cachedInput: cachedRate } : {})
    }
    // The same provider and model is one price: the new one replaces it.
    const rest = prices.filter((p) => !(p.provider === provider && p.model.toLowerCase() === id.toLowerCase()))
    save([...rest, entry])
    setModel('')
    setInput('')
    setOutput('')
    setCached('')
    setError(null)
  }

  return (
    <>
      {prices.map((p, i) => (
        <SettingsItem
          key={`${p.provider}\0${p.model}`}
          id={`custom-price-${i}`}
          title={p.model}
          hint={`${labelOf(p.provider)} · ${priceLine(p)}`}
        >
          <IconButton
            icon="close"
            size="xs"
            tone="muted"
            label={`Remove the price for ${p.model}`}
            disabled={form.formLocked}
            onClick={() => save(prices.filter((_, at) => at !== i))}
          />
        </SettingsItem>
      ))}
      <SettingsField
        id="custom-prices"
        title={prices.length ? 'Add a price' : 'Prices'}
        hint="For a model the app cannot price: a custom endpoint, a negotiated rate. USD per 1M tokens; a * at the end of the id matches a prefix."
        help="A price here wins over the built-in table and the models.dev catalog. Runs started after the change use it."
        wide
      >
        <div className="space-y-1.5">
        {/* Widths come from wrappers: Input is w-full and cn() has no merge. */}
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <div className="w-40 shrink-0">
          <Menu
            aria-label="Provider"
            value={provider}
            options={providerOptions}
            searchable={providerOptions.length > 12}
            placement="down"
            disabled={form.formLocked}
            triggerClassName={cn(selectTriggerClass({ quiet: false, mono: false }), 'w-full')}
            onChange={(next) => setProvider(next)}
          />
          </div>
          <div className="min-w-40 flex-1">
          <Input
            size="sm"
            aria-label="Model id"
            placeholder="Model id or prefix*"
            className="font-mono"
            value={model}
            disabled={form.formLocked}
            onChange={(e) => setModel(e.target.value)}
          />
          </div>
          <div className="w-20 shrink-0">
          <Input
            size="sm"
            aria-label="Input price, USD per 1M tokens"
            placeholder="In $"
            inputMode="decimal"
            value={input}
            disabled={form.formLocked}
            onChange={(e) => setInput(e.target.value)}
          />
          </div>
          <div className="w-20 shrink-0">
          <Input
            size="sm"
            aria-label="Output price, USD per 1M tokens"
            placeholder="Out $"
            inputMode="decimal"
            value={output}
            disabled={form.formLocked}
            onChange={(e) => setOutput(e.target.value)}
          />
          </div>
          <div className="w-20 shrink-0">
          <Input
            size="sm"
            aria-label="Cached input price, USD per 1M tokens (optional)"
            placeholder="Cached $"
            inputMode="decimal"
            value={cached}
            disabled={form.formLocked}
            onChange={(e) => setCached(e.target.value)}
          />
          </div>
          <Button
            size="sm"
            type="submit"
            disabled={form.formLocked || prices.length >= MAX_CUSTOM_MODEL_PRICES}
          >
            Add
          </Button>
        </form>
        {error ? (
          <p role="alert" className="m-0 text-xs text-danger">
            {error}
          </p>
        ) : null}
        </div>
      </SettingsField>
    </>
  )
}
