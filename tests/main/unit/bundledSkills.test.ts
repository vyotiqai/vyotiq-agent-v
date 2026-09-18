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

  /**
   * Package directories that predate this test and are in no catalog entry.
   * Each also exists as a nested copy inside a plugin (quality/skills/…,
   * shipping/skills/…), so the top-level copies ship in every build while being
   * unreachable from Browse. Listed rather than deleted here — removing shipped
   * content is the maintainer's call, not a test's.
   */
  const KNOWN_UNLISTED = new Set([
    'analyze-api',
    'code-review',
    'commit-message',
    'debug',
    'docs',
    'pr-description',
    'refactor',
    'security-review',
    'test-writing'
  ])

  it('adds no new unlisted package directories', () => {
    const catalogPaths = new Set(catalog.packages.map((p) => p.bundledPath ?? p.id))
    const orphans = readdirSync(PACKAGES_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !catalogPaths.has(name) && !KNOWN_UNLISTED.has(name))
    expect(orphans).toEqual([])
  })
})
