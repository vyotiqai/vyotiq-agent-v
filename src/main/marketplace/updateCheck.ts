import type { MarketplaceInstalledItem, MarketplacePackageUpdate } from '../../shared/ipc'

/**
 * Whether a package installed from npm, git or a registry has a newer
 * version. Bundled packages refresh with the app; a path, zip or remote URL
 * has nothing to compare against. Only items installed since the origin was
 * recorded can be checked: the store did not keep where older ones came from.
 *
 * Nothing is downloaded here. Updating is the same install again, from the
 * same source, which the person starts.
 */

export type UpdateCheckDeps = {
  /** The npm registry's latest version of a package. */
  npmLatest: (name: string) => Promise<string | null>
  /** The commit a git remote's HEAD points at. */
  gitHead: (url: string) => Promise<string | null>
  /** The catalog's version of a registry package, by id. */
  registryVersion: (id: string) => Promise<string | null>
}

/** `@scope/name@^1.2` → `@scope/name`; `name@latest` → `name`. */
export function npmPackageName(target: string): string {
  const t = target.trim()
  const at = t.startsWith('@') ? t.indexOf('@', 1) : t.indexOf('@')
  return at > 0 ? t.slice(0, at) : t
}

export function updatableSource(item: MarketplaceInstalledItem): boolean {
  return Boolean(item.origin?.target) && (item.installSource === 'npm' || item.installSource === 'git' || item.installSource === 'registry')
}

export async function checkPackageUpdates(
  items: readonly MarketplaceInstalledItem[],
  deps: UpdateCheckDeps
): Promise<{ updates: MarketplacePackageUpdate[]; checked: number; failed: string[] }> {
  const updates: MarketplacePackageUpdate[] = []
  const failed: string[] = []
  let checked = 0
  for (const item of items) {
    if (!updatableSource(item)) continue
    const origin = item.origin!
    checked += 1
    try {
      if (item.installSource === 'npm') {
        const name = npmPackageName(origin.target)
        const latest = await deps.npmLatest(name)
        const current = origin.ref ?? item.version
        if (latest && latest !== current) {
          updates.push({ id: item.id, name: item.name, source: 'npm', current, latest, target: name })
        }
      } else if (item.installSource === 'git') {
        const head = await deps.gitHead(origin.target)
        if (head && origin.ref && head !== origin.ref) {
          updates.push({
            id: item.id,
            name: item.name,
            source: 'git',
            current: origin.ref.slice(0, 7),
            latest: head.slice(0, 7),
            target: origin.target
          })
        }
      } else {
        const latest = await deps.registryVersion(origin.target)
        if (latest && latest !== item.version) {
          updates.push({ id: item.id, name: item.name, source: 'registry', current: item.version, latest, target: origin.target })
        }
      }
    } catch {
      failed.push(item.name)
    }
  }
  return { updates, checked, failed }
}
