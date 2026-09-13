import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  VyotiqMcpManifestSchema,
  VyotiqPluginManifestSchema,
  type MarketplaceCatalogEntry,
  type MarketplaceInstalledItem,
  type PackageContents
} from '../../shared/ipc'
import { parseSkillFrontmatter } from '../agent/skills/parse'
import { resolveSkillMdPath, SKILL_MD } from '../agent/skills/paths'
import { loadBundledCatalog, loadCachedRemoteCatalog, mergeCatalogs } from './catalog'
import { getInstalledItem } from './indexStore'
import { bundledPackagePath, resolveInstalledPackageRoot } from './paths'
import { resolveInsidePackageRoot } from './safePath'

export type { PackageContents }

/** Describe nested contents of an installed package (for Marketplace UI detail). */
export function getInstalledPackageContents(id: string): PackageContents | null {
  const item = getInstalledItem(id)
  if (!item) return null
  return describePackageAt(resolveInstalledPackageRoot(item.packagePath), item)
}

/**
 * Resolve package contents for Marketplace detail:
 * installed → bundled on-disk → contentsPreview from catalog.
 */
export function getPackageContents(id: string): PackageContents | null {
  const installed = getInstalledPackageContents(id)
  if (installed) return installed

  const entries = mergeCatalogs(loadBundledCatalog(), loadCachedRemoteCatalog())
  const entry = entries.find((e) => e.id === id)
  if (!entry) return null

  if (entry.bundledPath) {
    try {
      return describePackageAt(bundledPackagePath(entry.bundledPath), {
        id: entry.id,
        kind: entry.kind
      })
    } catch {
      // fall through to preview
    }
  }

  const preview = entry.contentsPreview
  if (!preview) return null
  return {
    id: entry.id,
    kind: entry.kind,
    mcp: (preview.mcp ?? []).map((m) => ({ id: m.id, name: m.name, path: '' })),
    skills: (preview.skills ?? []).map((s) => ({
      name: s.name,
      description: s.description ?? '',
      path: ''
    })),
    rules: (preview.rules ?? []).map((r) => ({ path: r.path }))
  }
}

/** Find a catalog entry by id from bundled + cached remote. */
export function findCatalogEntry(id: string): MarketplaceCatalogEntry | undefined {
  return mergeCatalogs(loadBundledCatalog(), loadCachedRemoteCatalog()).find((e) => e.id === id)
}

export function describePackageAt(
  root: string,
  item: Pick<MarketplaceInstalledItem, 'id' | 'kind'>
): PackageContents {
  const out: PackageContents = {
    id: item.id,
    kind: item.kind,
    mcp: [],
    skills: [],
    rules: []
  }

  if (item.kind === 'mcp') {
    const manifestPath = join(root, 'vyotiq.mcp.json')
    if (existsSync(manifestPath)) {
      const m = VyotiqMcpManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
      out.mcp.push({
        id: m.id,
        name: m.name,
        path: 'vyotiq.mcp.json',
        transport: m.transport,
        ...(m.url ? { url: m.url } : {}),
        ...(m.command ? { command: m.command } : {})
      })
    }
    return out
  }

  if (item.kind === 'skill') {
    const skillPath = resolveSkillMdPath(root)
    if (skillPath) {
      const skill = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
      out.skills.push({
        name: skill.name,
        description: skill.description,
        path: SKILL_MD
      })
    }
    return out
  }

  const pluginPath = join(root, 'vyotiq.plugin.json')
  if (!existsSync(pluginPath)) return out
  const plugin = VyotiqPluginManifestSchema.parse(JSON.parse(readFileSync(pluginPath, 'utf8')))
  for (const rel of plugin.mcp) {
    let mcpManifest: string
    try {
      mcpManifest = join(resolveInsidePackageRoot(root, rel), 'vyotiq.mcp.json')
    } catch {
      continue
    }
    if (!existsSync(mcpManifest)) continue
    try {
      const m = VyotiqMcpManifestSchema.parse(JSON.parse(readFileSync(mcpManifest, 'utf8')))
      out.mcp.push({
        id: m.id,
        name: m.name,
        path: rel,
        transport: m.transport,
        ...(m.url ? { url: m.url } : {}),
        ...(m.command ? { command: m.command } : {})
      })
    } catch {
      // skip
    }
  }
  for (const rel of plugin.skills) {
    let skillDir: string
    try {
      skillDir = resolveInsidePackageRoot(root, rel)
    } catch {
      continue
    }
    const skillPath = resolveSkillMdPath(skillDir)
    if (!skillPath) continue
    try {
      const skill = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
      out.skills.push({ name: skill.name, description: skill.description, path: rel })
    } catch {
      // skip
    }
  }
  for (const rel of plugin.rules) {
    try {
      if (existsSync(resolveInsidePackageRoot(root, rel))) out.rules.push({ path: rel })
    } catch {
      // skip
    }
  }
  return out
}
