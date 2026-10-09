/**
 * Common OpenAI-compatible hosts, so adding one is a pick rather than knowing
 * its base URL. Each still needs its own key (local servers do not), pasted on
 * the endpoint's row once it is added.
 */
export type EndpointPreset = {
  id: string
  name: string
  baseUrl: string
  /** Runs on this machine: no key, and the app can look for it. */
  local?: boolean
  /** Where the key comes from. */
  keyUrl?: string
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { id: 'fireworks', name: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys' },
  { id: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai/' },
  { id: 'deepinfra', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', keyUrl: 'https://deepinfra.com/dash/api_keys' },
  { id: 'moonshot', name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', local: true },
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', local: true },
  { id: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', local: true }
]
