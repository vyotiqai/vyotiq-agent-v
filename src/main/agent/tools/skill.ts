import { existsSync, readFileSync, statSync } from 'fs'
import { basename } from 'path'
import {
  describeMissingSkill,
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
 * One sentence the agent can act on, and one the user can act on.
 *
 * Skills that hand off to other skills ("call the Skill tool with X") land here
 * whenever X is a Marketplace package nobody installed. Saying "unknown or
 * disabled" left the agent to guess between a typo and a toggle; naming the
 * state lets it tell the user exactly which card to press.
 */
export function missingSkillMessage(
  skillName: string,
  overrides: MarketplaceOverrides | null,
  workspaceRoot: string
): string {
  const reason = describeMissingSkill(skillName, overrides, workspaceRoot)
  switch (reason.kind) {
    case 'disabled':
      return `Skill "${skillName}" is installed but disabled. Enable "${reason.label}" in Extensions (or clear the workspace override) and try again.`
    case 'not_installed':
      return `Skill "${skillName}" is not installed. Install "${reason.label}" from Extensions — it is in the catalog, so nothing needs downloading — then try again.`
    case 'unknown': {
      const hint =
        reason.suggestions.length > 0
          ? ` Closest enabled skills: ${reason.suggestions.join(', ')}.`
          : ''
      return `Unknown skill/plugin-rule: ${skillName}. Check Available skills / Plugin rules for the exact name.${hint}`
    }
    default: {
      const _exhaustive: never = reason
      return _exhaustive
    }
  }
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
    throw new Error(missingSkillMessage(skillName, overrides, workspaceRoot))
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
