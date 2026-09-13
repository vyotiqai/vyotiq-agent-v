import { type SecretProvider, type Settings } from '@shared/ipc'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function workspaceShort(path: string | null): string {
  return formatWorkspaceName(path)
}

export function defaultKeyProvider(
  settingsProvider: Settings['provider'],
  _secrets: Record<SecretProvider, boolean>
): SecretProvider {
  return settingsProvider
}

/** One hostname or `*.suffix` per line (commas also accepted). Empty = allow all. */
export function parseBrowserDomainAllowlist(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((raw) => normalizeBrowserDomainEntry(raw))
    .filter(Boolean)
}

export function formatBrowserDomainAllowlist(list: string[] | undefined | null): string {
  if (!list || list.length === 0) return ''
  return list.join('\n')
}

function normalizeBrowserDomainEntry(raw: string): string {
  let entry = raw.trim()
  if (!entry) return ''
  try {
    if (entry.includes('://')) {
      entry = new URL(entry).hostname
    } else if (entry.includes('/')) {
      entry = new URL(`https://${entry}`).hostname
    }
  } catch {
    // keep literal hostname / wildcard entry
  }
  return entry.replace(/\.$/, '')
}
