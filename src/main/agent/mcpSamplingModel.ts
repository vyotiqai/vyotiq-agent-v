import type { Settings } from '../../shared/ipc'
import { resolveEffectiveSettings } from '../../shared/domain/effectiveSettings'
import { providerNeedsKey, resolveProviderChatBaseUrl } from '../../shared/domain/providers'
import { estimateStepCost } from '../../shared/pricing/modelPrices'
import { logger } from '../../shared/logger'
import { getSecret } from '../settings/secrets'
import { getSettings } from '../settings/settings'
import { findWorkspaceSettingsOverride, readWorkspacesState } from '../workspace/workspaces'
import { workspaceUsageDir } from '../storage/paths'
import { getProvider } from './providers'
import { usableUtilityModel } from './sideModels'
import { recordAuxUsage } from './usageLedger'
import { resolveRunModelPrice } from './pricing'
import { samplingModelFor, type SamplingModel } from './mcp/sampling'

/**
 * The model that answers an MCP server's sampling request in a workspace:
 * the utility model when one is set (it is a side call), else the
 * workspace's chat model. Its spend goes to the workspace's side-call ledger.
 */
export function mcpSamplingModel(workspacePath: string | null): SamplingModel | null {
  const global = getSettings()
  const override = workspacePath ? findWorkspaceSettingsOverride(readWorkspacesState(), workspacePath) : null
  let settings: Settings = { ...global, ...resolveEffectiveSettings(global, override) }
  const utility = usableUtilityModel(settings)
  if (utility) settings = { ...settings, provider: utility.provider, model: utility.model }
  return samplingModelFor({
    settings,
    getSecret: (provider) => getSecret(provider as Settings['provider']),
    resolveBaseUrl: (s, apiKey) => resolveProviderChatBaseUrl(s.provider, s, apiKey),
    needsKey: (s, baseUrl) => providerNeedsKey(s.provider, baseUrl ?? s.ollamaBaseUrl),
    stream: (s, req) =>
      getProvider(s.provider).streamChat({
        model: s.model,
        apiKey: req.apiKey,
        baseUrl: req.baseUrl,
        signal: req.signal,
        tools: [],
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        thinking: { enabled: false }
      }),
    recordUsage: (s, baseUrl, usage) => {
      if (!workspacePath) return
      void (async () => {
        try {
          const price = usage.billedCost == null ? await resolveRunModelPrice(s.provider, s.model, baseUrl) : null
          const estimated = price ? (estimateStepCost(usage, price) ?? undefined) : undefined
          recordAuxUsage(workspaceUsageDir(workspacePath), {
            site: 'mcp_sampling',
            ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
            ...(usage.cachedInputTokens != null ? { cachedInputTokens: usage.cachedInputTokens } : {}),
            ...(usage.billedCost != null ? { billedCost: usage.billedCost } : {}),
            ...(estimated !== undefined ? { estimatedCost: estimated } : {})
          })
        } catch (err) {
          logger.warn('Could not record the MCP sampling spend', { scope: 'mcp', err })
        }
      })()
    }
  })
}
