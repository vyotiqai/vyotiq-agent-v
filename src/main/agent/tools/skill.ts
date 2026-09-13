import { existsSync, readFileSync, statSync } from 'fs'
import { basename } from 'path'
import {
  findEnabledSkillByName,
  findPluginRuleById,
  listSkillBundledFiles,
  loadPluginRuleBody,
  resolveSkillResourcePath
} from '../skills'
import { isSkillMdFilename, resolveSkillMdPath, SKILL_MD } from '../skills/paths'
import { findWorkspaceSettingsOverride, getWorkspaces } from '../../workspace/workspaces'
import { wrapUntrustedContent } from '../untrustedContent'
import type { MarketplaceOverrides } from '../../../shared/ipc'

function marketplaceOverridesFor(workspacePath: string): MarketplaceOverrides | null {
  const override = findWorkspaceSettingsOverride(getWorkspaces(), workspacePath)
  return override?.marketplaceOverrides ?? null
}

/**
 * Load an enabled Marketplace skill (Agent Skills progressive disclosure Level 2/3)
 * or an enabled plugin rule (`plugin-rule:<pluginId>/<relPath>`).
 * Skills and plugin rules live outside the workspace sandbox; this is the sanctioned load path.
 */
export function toolSkill(
  workspaceRoot: string,
  name: string,
  relPath?: string
): string {
  const skillName = name.trim()
  if (!skillName) {
    throw new Error('Skill name is required')
  }

  const overrides = marketplaceOverridesFor(workspaceRoot)

  const pluginRule = findPluginRuleById(skillName, overrides)
  if (pluginRule) {
    return wrapUntrustedContent(loadPluginRuleBody(pluginRule), {
      source: 'skill',
      origin: skillName,
      kind: 'plugin_rule'
    })
  }

  const skill = findEnabledSkillByName(skillName, overrides, workspaceRoot)
  if (!skill) {
    throw new Error(
      `Unknown or disabled skill/plugin-rule: ${skillName}. Enable it in Marketplace, or check Available skills / Plugin rules.`
    )
  }

  const requested = (relPath ?? '').trim().replace(/\\/g, '/')
  const loadingRootSkill =
    !requested ||
    requested === SKILL_MD ||
    requested === 'skill.md' ||
    isSkillMdFilename(requested)

  if (loadingRootSkill) {
    const skillFile = resolveSkillMdPath(skill.root) ?? skill.skillPath
    if (!existsSync(skillFile)) {
      throw new Error(`SKILL.md missing for skill: ${skill.name}`)
    }
    const raw = readFileSync(skillFile, 'utf8')
    // Prefer body without frontmatter for instructions; keep a short header.
    let body = skill.body.trim()
    if (!body) {
      // Re-parse if LoadedSkill body empty (shouldn't happen)
      const start = raw.indexOf('\n---')
      body = (start >= 0 ? raw.slice(start + 4) : raw).trim()
    }
    const bundled = listSkillBundledFiles(skill.root)
    const extras =
      bundled.length > 0
        ? [
            '',
            '## Bundled files',
            'Load with Skill tool using the same name and a relative path:',
            ...bundled.map((f) => `- ${f}`)
          ].join('\n')
        : ''
    const out = [
      `# Skill: ${skill.name}`,
      '',
      wrapUntrustedContent(
        [body, extras].filter(Boolean).join('\n'),
        { source: 'skill', origin: skill.name, kind: 'skill_body' }
      )
    ]
      .filter(Boolean)
      .join('\n')
      .trim()
    return out
  }

  let abs: string
  try {
    abs = resolveSkillResourcePath(skill.root, requested)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
  if (!existsSync(abs)) {
    throw new Error(`File not found in skill ${skill.name}: ${requested}`)
  }
  let st
  try {
    st = statSync(abs)
  } catch {
    throw new Error(`Cannot stat skill file: ${requested}`)
  }
  if (st.isDirectory()) {
    const kids = listSkillBundledFiles(abs, 60).map((f) =>
      requested ? `${requested.replace(/\/$/, '')}/${f}` : f
    )
    return [`Directory: ${requested}`, ...kids.map((k) => `- ${k}`)].join('\n')
  }
  const content = readFileSync(abs, 'utf8')
  const header = `# Skill file: ${skill.name} / ${requested}\n\n`
  return (
    header +
    wrapUntrustedContent(content, {
      source: 'skill',
      origin: `${skill.name}/${requested}`,
      kind: 'skill_file'
    })
  )
}

export function summarizeSkillArgs(name: string, path?: string): string {
  const n = name.trim() || 'skill'
  const p = (path ?? '').trim()
  if (!p || isSkillMdFilename(basename(p))) return n
  return `${n}:${p}`
}
