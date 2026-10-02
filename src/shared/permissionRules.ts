import type { PermissionRule } from './ipc/schemas/settings'

/**
 * Built-in permission defaults, shared so Settings can list exactly what main
 * enforces (src/main/agent/permissions.ts).
 */

/** A workspace's own rules, which travel with the folder. Deny and ask only. */
export const WORKSPACE_PERMISSIONS_FILE = '.vyotiq/permissions.json'

/**
 * Secrets the agent asks before touching, whatever the approval mode says.
 * A `path` allow rule of your own that covers one lets it through.
 */
export const DEFAULT_ASK_PATHS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/id_rsa*',
  '~/.ssh/**',
  '~/.aws/credentials'
]

/** Template env files that hold no secrets: not covered by `**\/.env.*`. */
export const DEFAULT_ASK_PATH_EXCEPTIONS: readonly string[] = ['**/.env.example', '**/.env.sample', '**/.env.template']

/** What Settings says is always denied, in the words it uses. */
export const PROTECTED_PATH_NOTES: readonly string[] = [
  "The app's data folder — keys, settings, browser cookies",
  `${WORKSPACE_PERMISSIONS_FILE} — read, never written`
]

export type PermissionRuleKind = 'tool' | 'command' | 'path'

/** `deny path .env`, `ask command git push`, `allow tool read · path src/**`. */
export function permissionRuleLabel(rule: PermissionRule): string {
  const parts: string[] = []
  if (rule.tool) parts.push(`tool ${rule.tool}`)
  if (rule.command) parts.push(`command ${rule.command}`)
  if (rule.path) parts.push(`path ${rule.path}`)
  return `${rule.effect} ${parts.join(' · ')}`
}
