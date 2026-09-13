import { existsSync, lstatSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import type { MarketplaceOverrides } from '../../../shared/ipc'
import { VyotiqPluginManifestSchema } from '../../../shared/ipc'
import { effectiveMarketplaceEnabled } from '../../../shared/domain/marketplaceEnablement'
import { parseSkillFrontmatter } from './parse'
import { isSkillMdFilename, resolveSkillMdPath } from './paths'
import { loadLocalSkills } from './local'
import { readMarketplaceIndex } from '../../marketplace/indexStore'
import { resolveInstalledPackageRoot } from '../../marketplace/paths'
import { resolveInsidePackageRoot } from '../../marketplace/safePath'
import { wrapPromptSection } from '../promptSections'

export type LoadedSkillSource = 'project' | 'personal' | 'skill' | 'plugin'

export type LoadedSkill = {
  id: string
  name: string
  description: string
  body: string
  /** Absolute directory containing SKILL.md */
  root: string
  /** Absolute path to the resolved SKILL.md (or legacy skill.md) */
  skillPath: string
  source: LoadedSkillSource
}

function loadSkillFromDir(
  skillDir: string
): { name: string; description: string; body: string; skillPath: string } | null {
  const skillPath = resolveSkillMdPath(skillDir)
  if (!skillPath) return null
  try {
    const parsed = parseSkillFrontmatter(readFileSync(skillPath, 'utf8'))
    return {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      skillPath
    }
  } catch {
    return null
  }
}

/** Resolve a plugin-listed skill path to a skill directory (or the file's parent). */
function resolvePluginSkillDir(root: string, rel: string): string | null {
  try {
    const asDir = resolveInsidePackageRoot(root, rel)
    if (resolveSkillMdPath(asDir)) return asDir
    if (existsSync(asDir) && isSkillMdFilename(asDir)) {
      // rel pointed at the markdown file itself
      return dirname(asDir)
    }
    const mdAlt = resolveInsidePackageRoot(root, `${rel}.md`)
    if (existsSync(mdAlt) && isSkillMdFilename(mdAlt)) {
      return dirname(mdAlt)
    }
    return asDir
  } catch {
    return null
  }
}

function sourceRank(source: LoadedSkillSource): number {
  switch (source) {
    case 'project':
      return 4
    case 'personal':
      return 3
    case 'skill':
      return 2
    case 'plugin':
      return 1
    default: {
      const _exhaustive: never = source
      return _exhaustive
    }
  }
}

/** Load all effectively enabled skills (local filesystem + marketplace). */
export function loadEnabledSkills(
  marketplaceOverrides?: MarketplaceOverrides | null,
  workspacePath?: string | null
): LoadedSkill[] {
  const index = readMarketplaceIndex()
  const skills: LoadedSkill[] = []

  for (const local of loadLocalSkills(workspacePath)) {
    skills.push({
      id: local.id,
      name: local.name,
      description: local.description,
      body: local.body,
      root: local.root,
      skillPath: local.skillPath,
      source: local.source
    })
  }

  for (const item of index.items) {
    if (item.kind !== 'skill') continue
    if (!effectiveMarketplaceEnabled(item.id, item.enabled, marketplaceOverrides, 'skills')) {
      continue
    }
    const root = resolveInstalledPackageRoot(item.packagePath)
    const loaded = loadSkillFromDir(root)
    if (!loaded) continue
    skills.push({
      id: item.id,
      name: loaded.name,
      description: loaded.description,
      body: loaded.body,
      root,
      skillPath: loaded.skillPath,
      source: 'skill'
    })
  }

  for (const item of index.items) {
    if (item.kind !== 'plugin') continue
    if (!effectiveMarketplaceEnabled(item.id, item.enabled, marketplaceOverrides, 'plugins')) {
      continue
    }
    const root = resolveInstalledPackageRoot(item.packagePath)
    const manifestPath = join(root, 'vyotiq.plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const plugin = VyotiqPluginManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, 'utf8'))
      )
      for (const rel of plugin.skills) {
        const skillDir = resolvePluginSkillDir(root, rel)
        if (!skillDir) continue
        const loaded = loadSkillFromDir(skillDir)
        if (!loaded) continue
        skills.push({
          id: `${plugin.id}/${loaded.name}`,
          name: loaded.name,
          description: loaded.description,
          body: loaded.body,
          root: skillDir,
          skillPath: loaded.skillPath,
          source: 'plugin'
        })
      }
    } catch {
      // skip
    }
  }

  return skills
}

/**
 * Prefer one entry per skill name (project > personal > marketplace > plugin).
 */
export function dedupeSkillsByName(skills: LoadedSkill[]): LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>()
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase()
    if (!key) continue
    const existing = byName.get(key)
    if (!existing || sourceRank(skill.source) > sourceRank(existing.source)) {
      byName.set(key, skill)
    }
  }
  return [...byName.values()]
}

/**
 * Level-1 progressive disclosure: name + description only.
 * Full SKILL.md body is loaded on demand via the Skill tool or slash invocation.
 */
export function buildSkillsSection(skills: LoadedSkill[], maxChars = 12_000): string {
  const unique = dedupeSkillsByName(skills)
  if (unique.length === 0) return ''
  const header = [
    'Match: call the `Skill` tool with that `name`, then the same `name` plus a relative `path` for bundled files. Users may also `/name`.',
    ''
  ].join('\n')

  const blocks: string[] = [header]
  let used = header.length
  for (const skill of unique) {
    const line = `- **${skill.name}**: ${skill.description}\n`
    if (used + line.length > maxChars) {
      blocks.push('\n_Additional skills omitted to fit context budget._')
      break
    }
    blocks.push(line)
    used += line.length
  }
  return wrapPromptSection('available_skills', blocks.join('').trim())
}

/** List shallow relative files under a skill root (for Skill tool discovery). */
export function listSkillBundledFiles(skillRoot: string, cap = 40): string[] {
  const out: string[] = []
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (out.length >= cap || depth > 3) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (out.length >= cap) return
      if (name === '.git' || name === 'node_modules') continue
      const abs = join(dir, name)
      let st
      try {
        // lstat: do not follow symlinks (containment — mirrors resolveInsidePackageRoot).
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      const rel = prefix ? `${prefix}/${name}` : name
      if (st.isDirectory()) {
        walk(abs, rel, depth + 1)
      } else if (!isSkillMdFilename(name) || prefix) {
        out.push(rel.replace(/\\/g, '/'))
      }
    }
  }
  walk(skillRoot, '', 0)
  return out
}

/** Resolve a relative path under a skill root with containment. */
export function resolveSkillResourcePath(skillRoot: string, relPath: string): string {
  return resolveInsidePackageRoot(skillRoot, relPath)
}

/** Find an enabled skill by name (case-insensitive). Prefer project/personal over marketplace. */
export function findEnabledSkillByName(
  name: string,
  marketplaceOverrides?: MarketplaceOverrides | null,
  workspacePath?: string | null
): LoadedSkill | undefined {
  const key = name.trim().toLowerCase()
  if (!key) return undefined
  const unique = dedupeSkillsByName(loadEnabledSkills(marketplaceOverrides, workspacePath))
  return unique.find((s) => s.name.toLowerCase() === key)
}

export type LoadedPluginRule = {
  /** Stable id for the Skill tool: `plugin-rule:<pluginId>/<relPath>`. */
  id: string
  pluginId: string
  pluginName: string
  relPath: string
  description: string
  absPath: string
}

function pluginRuleId(pluginId: string, relPath: string): string {
  return `plugin-rule:${pluginId}/${relPath.replace(/\\/g, '/')}`
}

function oneLineRuleDescription(text: string, fallback: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (line) return line.slice(0, 160)
  }
  return fallback.slice(0, 160)
}

/** Enumerate enabled plugin rule files (marketplace packages; outside workspace). */
export function listEnabledPluginRules(
  marketplaceOverrides?: MarketplaceOverrides | null
): LoadedPluginRule[] {
  const index = readMarketplaceIndex()
  const out: LoadedPluginRule[] = []
  for (const item of index.items) {
    if (item.kind !== 'plugin') continue
    if (!effectiveMarketplaceEnabled(item.id, item.enabled, marketplaceOverrides, 'plugins')) {
      continue
    }
    const root = resolveInstalledPackageRoot(item.packagePath)
    const manifestPath = join(root, 'vyotiq.plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const plugin = VyotiqPluginManifestSchema.parse(
        JSON.parse(readFileSync(manifestPath, 'utf8'))
      )
      for (const rel of plugin.rules) {
        const relNorm = rel.replace(/\\/g, '/')
        let absPath: string
        try {
          absPath = resolveInsidePackageRoot(root, relNorm)
        } catch {
          continue
        }
        if (!existsSync(absPath)) continue
        let text = ''
        try {
          text = readFileSync(absPath, 'utf8').trim()
        } catch {
          continue
        }
        if (!text) continue
        out.push({
          id: pluginRuleId(plugin.id, relNorm),
          pluginId: plugin.id,
          pluginName: plugin.name,
          relPath: relNorm,
          description: oneLineRuleDescription(text, plugin.name),
          absPath
        })
      }
    } catch {
      // skip
    }
  }
  return out
}

/**
 * Level-1 progressive disclosure for plugin rules: id + one-line description.
 * Full rule body loads via the Skill tool with the listed `id` (marketplace paths
 * are outside the workspace `read` sandbox).
 */
export function loadPluginRules(
  marketplaceOverrides?: MarketplaceOverrides | null,
  maxChars = 12_000
): string {
  const rules = listEnabledPluginRules(marketplaceOverrides)
  if (rules.length === 0) return ''
  const header = [
    'Match: call the `Skill` tool with that rule `id`, then follow its body. Do not `read` plugin-rule paths (they live outside the workspace).',
    ''
  ].join('\n')

  const blocks: string[] = [header]
  let used = header.length
  for (const rule of rules) {
    const line = `- **${rule.id}** (${rule.pluginName}): ${rule.description}\n`
    if (used + line.length > maxChars) {
      blocks.push('\n_Additional plugin rules omitted to fit context budget._')
      break
    }
    blocks.push(line)
    used += line.length
  }
  return wrapPromptSection('plugin_rules', blocks.join('').trim())
}

/** Resolve a plugin-rule id (case-insensitive) from enabled plugins. */
export function findPluginRuleById(
  id: string,
  marketplaceOverrides?: MarketplaceOverrides | null
): LoadedPluginRule | undefined {
  const key = id.trim().toLowerCase()
  if (!key) return undefined
  return listEnabledPluginRules(marketplaceOverrides).find((r) => r.id.toLowerCase() === key)
}

/** Load full plugin rule markdown (sanctioned path outside workspace). */
export function loadPluginRuleBody(rule: LoadedPluginRule): string {
  const raw = readFileSync(rule.absPath, 'utf8').trim()
  return [`# Plugin rule: ${rule.pluginName}`, `Path: ${rule.relPath}`, '', raw].join('\n')
}
