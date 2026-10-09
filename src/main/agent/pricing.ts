import { catalogProviderId, type ProviderIdAny } from '../../shared/ipc/schemas/providers'
import {
  lookupModelsDevPrice,
  modelsDevRegistryLoaded,
  modelsDevRegistryPending
} from '../../shared/domain/modelsDevRegistry'
import {
  resolveModelPrice,
  setCustomModelPrices,
  setExternalPriceLookup,
  type ResolvedModelPrice
} from '../../shared/pricing/modelPrices'
import { getSettings, onSettingsWritten } from '../settings/settings'

/**
 * How long a run start waits for models.dev before pricing without it. The
 * registry is warmed at launch, so this only matters for the first run after
 * a cold start on a slow network.
 */
const REGISTRY_WAIT_MS = 3_000

function hostOf(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined
  try {
    return new URL(rawUrl).host.toLowerCase()
  } catch {
    return undefined
  }
}

let installed = false

/**
 * Wire the price sources the shared resolver tries after its table: the
 * prices set in Settings (kept current as settings are written) and the
 * models.dev catalog. Idempotent.
 */
export function installPriceSources(): void {
  if (installed) return
  installed = true
  setExternalPriceLookup((provider, modelId, opts) => {
    let providerId: ReturnType<typeof catalogProviderId> | undefined
    try {
      providerId = catalogProviderId(provider as ProviderIdAny)
    } catch {
      providerId = undefined
    }
    return lookupModelsDevPrice(modelId, {
      ...(providerId ? { providerId } : {}),
      ...(hostOf(opts.baseUrl) ? { apiHost: hostOf(opts.baseUrl)! } : {})
    })
  })
  try {
    setCustomModelPrices(getSettings().customModelPrices)
    onSettingsWritten((next) => setCustomModelPrices(next.customModelPrices))
  } catch {
    // Settings unreadable at boot: the table and the catalog still price.
  }
}

/**
 * The price a run (or a side call) bills at. When nothing answers and the
 * catalog has not loaded yet, waits a moment for it once rather than leave
 * the run unpriced for good.
 */
export async function resolveRunModelPrice(
  provider: string,
  modelId: string,
  baseUrl?: string | null
): Promise<ResolvedModelPrice | null> {
  installPriceSources()
  const opts = baseUrl ? { baseUrl } : {}
  const first = resolveModelPrice(provider, modelId, opts)
  if (first || modelsDevRegistryLoaded()) return first
  // Only the load main started at launch is waited for; this never starts one.
  const pending = modelsDevRegistryPending()
  if (!pending) return first
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(resolve, REGISTRY_WAIT_MS)
      })
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
  return resolveModelPrice(provider, modelId, opts)
}
