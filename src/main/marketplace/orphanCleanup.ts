import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { logger } from '../../shared/logger'
import { readMarketplaceIndex } from './indexStore'
import { marketplacePackagesRoot } from './paths'

function dirHasFiles(root: string): boolean {
  if (!existsSync(root)) return false
  const stack = [root]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(cur)
    } catch {
      return false
    }
    for (const name of entries) {
      const full = join(cur, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isFile()) return true
      if (st.isDirectory()) stack.push(full)
    }
  }
  return false
}

/**
 * Remove empty package id directories that are not referenced by marketplace index.json.
 * Incomplete installs left empty package dirs; this only removes directories
 * that contain no files.
 */
export function purgeOrphanMarketplacePackageDirs(): { removed: number } {
  const root = marketplacePackagesRoot()
  if (!existsSync(root)) return { removed: 0 }
  const indexed = new Set(readMarketplaceIndex().items.map((i) => i.id))
  let removed = 0
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { removed: 0 }
  }
  for (const id of entries) {
    if (indexed.has(id)) continue
    const dir = join(root, id)
    let st
    try {
      st = statSync(dir)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (dirHasFiles(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
      logger.info('Removed orphan marketplace package dir', {
        scope: 'marketplace',
        id,
        removed: 1
      })
    } catch (err) {
      logger.warn('Failed to remove orphan marketplace package dir', {
        scope: 'marketplace',
        id,
        err
      })
    }
  }
  return { removed }
}
