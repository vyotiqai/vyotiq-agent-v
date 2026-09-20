import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { MarketplaceCatalogSchema } from '@shared/ipc'
import { parseSkillFrontmatter } from '@main/agent/skills/parse'

const ROOT = process.cwd()
const PACKAGES_ROOT = join(ROOT, 'resources/marketplace/packages')

const catalog = MarketplaceCatalogSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'resources/marketplace/catalog.json'), 'utf8')) as unknown
)
const skillEntries = catalog.packages.filter((p) => p.kind === 'skill')

describe('bundled skills', () => {
  it('ships the recurring-loop skills', () => {
    const ids = new Set(skillEntries.map((e) => e.id))
    for (const id of [
      'incident-triage',
      'pr-review-reply',
      'standup-digest',
      'dependency-upgrade',
      'release-notes',
      'repo-onboarding',
      'flake-hunter'
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it.each(skillEntries.map((e) => [e.id, e] as const))(
    '%s has a SKILL.md that parses',
    (id, entry) => {
      const path = join(PACKAGES_ROOT, entry.bundledPath ?? id, 'SKILL.md')
      expect(existsSync(path)).toBe(true)

      const parsed = parseSkillFrontmatter(readFileSync(path, 'utf8'))
      // `name` is the agent-facing identifier and must match the package id,
      // or an installed skill answers to a different name than it was listed as.
      expect(parsed.name).toBe(id)
      expect(parsed.description.length).toBeLessThanOrEqual(1024)
      expect(parsed.body.trim().length).toBeGreaterThan(0)
    }
  )

  it('ships no package directory that Browse cannot reach', () => {
    // Nothing resolves a bundled package except through a catalog entry's
    // `bundledPath`, so an unlisted directory is dead weight in every build.
    const catalogPaths = new Set(catalog.packages.map((p) => p.bundledPath ?? p.id))
    const orphans = readdirSync(PACKAGES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !catalogPaths.has(name))
    expect(orphans).toEqual([])
  })

  /**
   * Plugins carry their own nested skills. A top-level package that merely
   * repeats one ships the same bytes twice and, once listed, would put two
   * installable routes to one skill name in front of the user —
   * `dedupeSkillsByName` then silently drops whichever lost the source ranking.
   */
  it('does not repeat a plugin-nested skill as a standalone package', () => {
    const nested = new Map<string, string>()
    for (const entry of catalog.packages.filter((p) => p.kind === 'plugin')) {
      const pluginRoot = join(PACKAGES_ROOT, entry.bundledPath ?? entry.id, 'skills')
      if (!existsSync(pluginRoot)) continue
      for (const dir of readdirSync(pluginRoot, { withFileTypes: true })) {
        if (dir.isDirectory()) nested.set(dir.name, entry.id)
      }
    }

    const duplicated = [...nested]
      .filter(([name]) => existsSync(join(PACKAGES_ROOT, name, 'SKILL.md')))
      .map(([name, plugin]) => `${name} (also in ${plugin})`)
    expect(duplicated).toEqual([])
  })

  it('gives every SKILL.md under packages parseable frontmatter', () => {
    // Includes the plugin-nested copies, which no catalog entry names and the
    // per-entry test above therefore never reaches.
    const skillPaths: string[] = []
    const walk = (dir: string): void => {
      for (const child of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, child.name)
        if (child.isDirectory()) walk(full)
        else if (child.name === 'SKILL.md') skillPaths.push(full)
      }
    }
    walk(PACKAGES_ROOT)

    for (const path of skillPaths) {
      const parsed = parseSkillFrontmatter(readFileSync(path, 'utf8'))
      expect(parsed.name, path).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(parsed.description.trim().length, path).toBeGreaterThan(0)
      expect(parsed.body.trim().length, path).toBeGreaterThan(0)
    }
  })
})
