import { existsSync } from 'fs'
import { join } from 'path'

/** Canonical Agent Skills filename. */
export const SKILL_MD = 'SKILL.md'
/** Legacy Vyotiq filename still accepted for installed packages. */
export const LEGACY_SKILL_MD = 'skill.md'

/**
 * Resolve SKILL.md under a skill directory (prefer canonical, then legacy).
 * Returns undefined when neither file exists.
 */
export function resolveSkillMdPath(skillDir: string): string | undefined {
  const canonical = join(skillDir, SKILL_MD)
  if (existsSync(canonical)) return canonical
  const legacy = join(skillDir, LEGACY_SKILL_MD)
  if (existsSync(legacy)) return legacy
  return undefined
}

/** True if `path` looks like a skill markdown file (canonical or legacy). */
export function isSkillMdFilename(pathOrName: string): boolean {
  const base = pathOrName.replace(/\\/g, '/').split('/').pop() ?? ''
  return base === SKILL_MD || base === LEGACY_SKILL_MD
}
