/** Env keys that must never be injected into MCP child processes (case-insensitive). */
const BLOCKED_MCP_ENV_KEYS = new Set(
  [
    'PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'DYLD_FRAMEWORK_PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'DOTNET_STARTUP_HOOKS',
    'DOTNET_ADDITIONAL_DEPS',
    'JAVA_TOOL_OPTIONS',
    'PERL5OPT',
    'RUBYOPT',
    'BASH_ENV',
    'ENV',
    'IFS',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'OPENSSL_CONF'
  ].map((k) => k.toUpperCase())
)

function isBlockedMcpEnvKey(key: string): boolean {
  return BLOCKED_MCP_ENV_KEYS.has(key.toUpperCase())
}

/**
 * Strip dangerous process-control keys from MCP env overlays (manifest, settings, import).
 * Enforcement also happens in `buildMcpChildEnv` so every spawn path is covered.
 */
export function sanitizeMcpManifestEnv(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (isBlockedMcpEnvKey(key)) continue
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export { isBlockedMcpEnvKey, BLOCKED_MCP_ENV_KEYS }
