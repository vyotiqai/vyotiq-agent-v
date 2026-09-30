/**
 * Smoke: Agent Skills alignment against real bundled packages (isolated temp userData).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const REPO = process.cwd()
const PACKAGES = join(REPO, 'resources', 'marketplace', 'packages')
const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-skills-smoke-'))

/**
 * Publisher on the skills we author. The house template below (## Instructions,
 * the when-to-use / output contract) is a rule about how *we* write a skill, so
 * it is asserted over these only. The agent-facing contract every bundled skill
 * actually has to meet — parseable frontmatter, a name that matches the package
 * id, a non-empty body — is asserted over all of them regardless of author.
 */
const FIRST_PARTY = 'Agent V'

type CatalogEntry = {
  id: string
  kind: string
  publisher?: string
  source?: string
  installable?: boolean
  dependsOn?: string[]
}

function catalogPackages(): CatalogEntry[] {
  const catalog = JSON.parse(
    readFileSync(join(REPO, 'resources', 'marketplace', 'catalog.json'), 'utf8')
  ) as { packages: CatalogEntry[] }
  return catalog.packages
}

/**
 * Names a skill package tells the agent to load, from anywhere in the package —
 * SKILL.md and the reference files it links to both count, since the agent is
 * told to read those too.
 */
function skillToolTargets(packageDir: string): Set<string> {
  const found = new Set<string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) {
        walk(abs)
        continue
      }
      if (!/\.(md|sh)$/.test(name)) continue
      const text = readFileSync(abs, 'utf8')
      // "call the Skill tool with \"x\"" and "call the Skill tool twice, for
      // \"x\" and \"y\"" are the two shapes upstream uses.
      for (const call of text.matchAll(/Skill tool (?:twice, )?(?:with|for) ([^.\n]*)/g)) {
        for (const quoted of call[1]!.matchAll(/"([a-z0-9-]+)"/g)) found.add(quoted[1]!)
      }
    }
  }
  walk(packageDir)
  return found
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? USER_DATA : tmpdir()),
    getAppPath: () => REPO,
    isPackaged: false
  }
}))

describe('skills smoke (bundled + isolated marketplace)', () => {
  let skillDirs: string[] = []
  let firstPartyDirs: string[] = []

  beforeAll(async () => {
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
    mkdirSync(join(USER_DATA, 'personal-skills'), { recursive: true })
    const { setPersonalSkillsRootForTests } = await import('@main/agent/skills/local')
    setPersonalSkillsRootForTests(join(USER_DATA, 'personal-skills'))
    const skills = catalogPackages().filter((pkg) => pkg.kind === 'skill')
    skillDirs = skills.map((pkg) => join(PACKAGES, pkg.id))
    firstPartyDirs = skills
      .filter((pkg) => pkg.publisher === FIRST_PARTY)
      .map((pkg) => join(PACKAGES, pkg.id))
  })

  afterAll(async () => {
    const { setPersonalSkillsRootForTests } = await import('@main/agent/skills/local')
    setPersonalSkillsRootForTests(null)
    rmSync(USER_DATA, { recursive: true, force: true })
  })

  beforeEach(() => {
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('gives every bundled skill a loadable SKILL.md', () => {
    expect(firstPartyDirs.length).toBe(9)
    for (const dir of skillDirs) {
      expect(existsSync(join(dir, 'SKILL.md')), dir).toBe(true)
    }
  })

  it('bundles the shipped skills and the four plugins', () => {
    const skillIds = catalogPackages()
      .filter((pkg) => pkg.kind === 'skill' && pkg.publisher === FIRST_PARTY)
      .map((pkg) => pkg.id)
      .sort()
    expect(skillIds).toEqual([
      // Recurring-loop skills: each spans two connected tools on a cadence,
      // rather than restating what the agent already does on request.
      'dependency-upgrade',
      'design-level-up',
      'docs',
      'flake-hunter',
      'incident-triage',
      'pr-review-reply',
      'release-notes',
      'repo-onboarding',
      'standup-digest'
    ])
    expect(catalogPackages().filter((pkg) => pkg.kind === 'plugin').map((p) => p.id).sort()).toEqual([
      'devtools',
      'electron-app',
      'quality',
      'shipping'
    ])
  })

  /**
   * The bug this guards: a skill whose whole body is "Call the Skill tool with
   * X". Installed on its own it loaded, instructed the agent to call a sibling
   * nobody had installed, and the Skill tool threw. Every such handoff has to
   * be a declared dependency the installer can follow.
   */
  it('declares every skill a bundled skill hands off to', () => {
    const packages = catalogPackages()
    const ids = new Set(packages.map((pkg) => pkg.id))
    const undeclared: string[] = []
    // Plugins too: a nested skill that hands off is the same trap, and the
    // declaration would sit on the plugin's own catalog entry.
    for (const pkg of packages.filter((p) => existsSync(join(PACKAGES, p.id)))) {
      const declared = new Set(pkg.dependsOn ?? [])
      for (const target of skillToolTargets(join(PACKAGES, pkg.id))) {
        if (target === pkg.id) continue
        expect(ids.has(target), `${pkg.id} -> ${target} is not a catalog package`).toBe(true)
        if (!declared.has(target)) undeclared.push(`${pkg.id} -> ${target}`)
      }
    }
    expect(undeclared).toEqual([])
  })

  it('keeps dependsOn installable, bundled, and acyclic', () => {
    const packages = catalogPackages()
    const byId = new Map(packages.map((pkg) => [pkg.id, pkg]))
    for (const pkg of packages) {
      for (const dep of pkg.dependsOn ?? []) {
        const target = byId.get(dep)
        expect(target, `${pkg.id} -> ${dep}`).toBeTruthy()
        // The installer copies from resources and never downloads, so a remote
        // or Coming-soon dependency would be an install that cannot complete.
        expect(target!.source, `${pkg.id} -> ${dep}`).toBe('bundled')
        expect(target!.installable, `${pkg.id} -> ${dep}`).not.toBe(false)
        expect(dep, `${pkg.id} depends on itself`).not.toBe(pkg.id)
      }
    }

    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done') return
      if (state.get(id) === 'visiting') {
        cycles.push([...trail, id].join(' -> '))
        return
      }
      state.set(id, 'visiting')
      for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep, [...trail, id])
      state.set(id, 'done')
    }
    for (const pkg of packages) visit(pkg.id, [])
    expect(cycles).toEqual([])
  })

  it('parses every bundled SKILL.md with agentskills frontmatter', async () => {
    const { parseSkillFrontmatter, skillPackageVersion } = await import('@main/agent/skills/parse')
    for (const dir of skillDirs) {
      const raw = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      const parsed = parseSkillFrontmatter(raw)
      expect(parsed.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(parsed.description.length).toBeGreaterThan(20)
      expect(parsed.description.length).toBeLessThanOrEqual(1024)
      expect(skillPackageVersion(parsed)).toBeTruthy()
      expect(parsed.body.trim().length, dir).toBeGreaterThan(0)
    }
  })

  it('writes every first-party skill to the house template', async () => {
    const { parseSkillFrontmatter } = await import('@main/agent/skills/parse')
    for (const dir of firstPartyDirs) {
      const parsed = parseSkillFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
      expect(parsed.body.trim().length, dir).toBeGreaterThan(40)
      expect(parsed.body, dir).toMatch(/## Instructions/i)
    }
  })

  it('bundled skills declare intended scope, out-of-scope guidance, and output contracts', async () => {
    // `docs` is the one shipped skill written to a shorter house template: a
    // body of instructions, no scope table. `design-level-up` is the vendored
    // author's own structure and does not say "Use when" either.
    const contracts: Record<string, string[]> = {
      'dependency-upgrade': ['## when to use', '## when not to use', '## output', 'lockfile'],
      'flake-hunter': ['## when to use', '## when not to use', '## output', 'failure rate'],
      'incident-triage': ['## when to use', '## when not to use', '## output', 'regression test'],
      'pr-review-reply': ['## when to use', '## when not to use', '## output', 'review'],
      'release-notes': ['## when to use', '## when not to use', '## output', 'breaking changes'],
      'repo-onboarding': ['## when to use', '## when not to use', '## output', 'readme'],
      'standup-digest': ['## when to use', '## when not to use', '## output', 'shipped']
    }
    const { parseSkillFrontmatter } = await import('@main/agent/skills/parse')
    for (const [id, terms] of Object.entries(contracts)) {
      const parsed = parseSkillFrontmatter(readFileSync(join(PACKAGES, id, 'SKILL.md'), 'utf8'))
      const content = `${parsed.description}\n${parsed.body}`.toLowerCase()
      expect(parsed.description.toLowerCase()).toContain('use when')
      for (const term of terms) expect(content).toContain(term)
    }
  })

  it('detectPackageAt treats each standalone skill package as kind skill', async () => {
    const { detectPackageAt } = await import('@main/marketplace/install')
    const standalone = [
      'dependency-upgrade',
      'design-level-up',
      'docs',
      'flake-hunter',
      'incident-triage',
      'pr-review-reply',
      'release-notes',
      'repo-onboarding',
      'standup-digest'
    ]
    for (const id of standalone) {
      const detected = detectPackageAt(join(PACKAGES, id))
      expect(detected.kind, id).toBe('skill')
      expect(detected.id, id).toBeTruthy()
      expect(detected.version, id).toBeTruthy()
    }
  })

  it('buildSkillsSection is metadata-only, points at Skill tool, and dedupes names', async () => {
    const { parseSkillFrontmatter } = await import('@main/agent/skills/parse')
    const { buildSkillsSection } = await import('@main/agent/skills')
    const skills = skillDirs.map((dir, i) => {
      const parsed = parseSkillFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
      return {
        id: `smoke-${i}`,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        root: dir,
        skillPath: join(dir, 'SKILL.md'),
        source: 'skill' as const
      }
    })
    // Duplicate plugin copy of the first skill should not appear twice.
    const withDup = [
      ...skills,
      {
        ...skills[0]!,
        id: 'plugin-dup',
        source: 'plugin' as const,
        description: 'duplicate plugin copy'
      }
    ]
    const section = buildSkillsSection(withDup)
    expect(section).toContain('<available_skills>')
    expect(section).toContain('`Skill` tool')
    expect(section).toContain('design-level-up')
    expect(section).not.toMatch(/## Instructions/)
    expect(section).not.toContain('duplicate plugin copy')
    const nameHits = section.match(new RegExp(`\\*\\*${skills[0]!.name}\\*\\*`, 'g'))
    expect(nameHits?.length).toBe(1)
  })

  it('Skill tool loads a real bundled body and blocks escape', async () => {
    const skillRoot = join(PACKAGES, 'repo-onboarding')
    const skillsMod = await import('@main/agent/skills')
    const parsed = (await import('@main/agent/skills/parse')).parseSkillFrontmatter(
      readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    )
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockReturnValue({
      id: 'repo-onboarding',
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      root: skillRoot,
      skillPath: join(skillRoot, 'SKILL.md'),
      source: 'skill'
    })
    const { toolSkill } = await import('@main/agent/tools/skill')
    const loaded = toolSkill(USER_DATA, 'repo-onboarding')
    expect(loaded).toContain('architecture')
    expect(loaded).toMatch(/skill:\s*repo-onboarding/i)
    expect(() => toolSkill(USER_DATA, 'repo-onboarding', '../settings.json')).toThrow()
  })

  it('TOOL_REGISTRY exposes Skill as a builtin', async () => {
    const { AGENT_TOOLS, BUILTIN_TOOL_NAMES } = await import('@main/agent/schemas/tools')
    expect([...BUILTIN_TOOL_NAMES]).toContain('Skill')
    const skill = AGENT_TOOLS.find((t) => t.name === 'Skill')
    expect(skill).toBeTruthy()
    expect(skill!.description.toLowerCase()).toMatch(/skill/)
  })

  it('installs a bundled skill into temp marketplace and loadEnabledSkills finds it', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    const skillsMod = await import('@main/agent/skills')
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockRestore()

    const result = await installMarketplacePackage({
      source: 'bundled',
      target: 'repo-onboarding'
    })
    expect(result.item.kind).toBe('skill')
    expect(result.item.id).toBe('repo-onboarding')
    expect(result.item.enabled).toBe(true)

    const enabled = skillsMod.loadEnabledSkills()
    const installed = enabled.find((s) => s.name === 'repo-onboarding')
    expect(installed).toBeTruthy()
    expect(existsSync(installed!.skillPath)).toBe(true)

    const section = skillsMod.buildSkillsSection(enabled)
    expect(section).toContain('repo-onboarding')
    expect(section).toContain('`Skill` tool')
    expect(section).not.toMatch(/## Instructions/)

    const found = skillsMod.findEnabledSkillByName('repo-onboarding')
    expect(found?.name).toBe('repo-onboarding')

    const body = (await import('@main/agent/tools/skill')).toolSkill(USER_DATA, 'repo-onboarding')
    expect(body).toContain('architecture')
  })

  it('marks only bundled, installable entries as built-ins', () => {
    const builtIns = catalogPackages().filter(
      (pkg) => (pkg as CatalogEntry & { installByDefault?: boolean }).installByDefault
    )
    expect(builtIns.map((pkg) => pkg.id)).toEqual(['design-level-up'])
    for (const pkg of builtIns) {
      // Startup installs these without a click, so they must never reach the
      // network or the untrusted-source ack gate.
      expect(pkg.source, pkg.id).toBe('bundled')
      expect(pkg.installable, pkg.id).not.toBe(false)
    }
  })

  /**
   * A built-in arrives with no Add click, exactly once. The second half is the
   * contract that matters: an uninstall is the user's decision, and the next
   * launch must not quietly put the package back.
   */
  it('installs built-ins once at startup and respects an uninstall', async () => {
    const { writeMarketplaceIndex, readMarketplaceIndex, removeInstalledItem } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    rmSync(join(USER_DATA, 'marketplace', 'seeded-defaults.json'), { force: true })
    const { installDefaultBundledPackages } = await import('@main/marketplace/install')

    expect(await installDefaultBundledPackages()).toEqual(['design-level-up'])
    expect(readMarketplaceIndex().items.map((i) => i.id)).toEqual(['design-level-up'])
    // Nothing to do on the next launch.
    expect(await installDefaultBundledPackages()).toEqual([])

    removeInstalledItem('design-level-up')
    expect(await installDefaultBundledPackages()).toEqual([])
    expect(readMarketplaceIndex().items).toEqual([])
  })

  /**
   * SKILL.md drift is repaired elsewhere, but only SKILL.md: a built-in that
   * ships scripts would keep its first copy of them forever. A new bundled
   * version reinstalls the whole package — and a disabled one stays disabled.
   */
  it('refreshes an installed built-in when the app ships a new version', async () => {
    const { writeMarketplaceIndex, readMarketplaceIndex, setInstalledEnabled } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    rmSync(join(USER_DATA, 'marketplace', 'seeded-defaults.json'), { force: true })
    const { installDefaultBundledPackages } = await import('@main/marketplace/install')
    await installDefaultBundledPackages()
    setInstalledEnabled('design-level-up', false)

    const stale = readMarketplaceIndex().items.map((i) =>
      i.id === 'design-level-up' ? { ...i, version: '0.9.0' } : i
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: stale })

    expect(await installDefaultBundledPackages()).toEqual(['design-level-up'])
    const item = readMarketplaceIndex().items.find((i) => i.id === 'design-level-up')
    expect(item?.version).toBe('1.0.0')
    expect(item?.enabled).toBe(false)

    // The other bundle sharing this userData may carry a newer copy; an older
    // bundle must leave it alone rather than swap versions every launch.
    const newer = readMarketplaceIndex().items.map((i) =>
      i.id === 'design-level-up' ? { ...i, version: '1.10.0' } : i
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: newer })
    expect(await installDefaultBundledPackages()).toEqual([])
    expect(readMarketplaceIndex().items.find((i) => i.id === 'design-level-up')?.version).toBe(
      '1.10.0'
    )
  })

  /**
   * design-level-up tells the agent to run `scripts/slop_check.py`; the Skill
   * tool only reads files, so loading it has to say where it was installed.
   */
  it('serves the design skill with its directory, scripts and references', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    rmSync(join(USER_DATA, 'marketplace', 'seeded-defaults.json'), { force: true })
    const { installDefaultBundledPackages } = await import('@main/marketplace/install')
    await installDefaultBundledPackages()

    const { toolSkill } = await import('@main/agent/tools/skill')
    const loaded = toolSkill(USER_DATA, 'design-level-up')
    const dir = /Skill directory: (.+)/.exec(loaded)?.[1]?.trim()
    expect(dir).toBeTruthy()
    for (const file of [
      'scripts/slop_check.py',
      'scripts/tweak.py',
      'scripts/word_timestamps.py',
      'assets/tweak-panel.js',
      'assets/artboards.html',
      'references/advanced.md'
    ]) {
      expect(existsSync(join(dir!, file)), file).toBe(true)
      expect(loaded, file).toContain(file)
    }
    expect(toolSkill(USER_DATA, 'design-level-up', 'references/easy.md')).toContain(
      'Design system first'
    )
  })

  /**
   * "Unknown or disabled" was one message for three different problems, and it
   * named the wrong one for the case that actually happened.
   */
  it('says which of unknown, uninstalled, or disabled a missing skill is', async () => {
    const { writeMarketplaceIndex, setInstalledEnabled } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const { toolSkill } = await import('@main/agent/tools/skill')

    // In the catalog, nothing installed yet.
    expect(() => toolSkill(USER_DATA, 'release-notes')).toThrow(/not installed/i)
    expect(() => toolSkill(USER_DATA, 'release-notes')).not.toThrow(/disabled/i)

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    await installMarketplacePackage({ source: 'bundled', target: 'release-notes' })
    setInstalledEnabled('release-notes', false)
    expect(() => toolSkill(USER_DATA, 'release-notes')).toThrow(/installed but disabled/i)

    // Not a package at all.
    expect(() => toolSkill(USER_DATA, 'no-such-skill-anywhere')).toThrow(/Unknown skill/i)
  })

  /**
   * A skill may be user-invoked only. It stays off the prompt's
   * available-skills list — the agent must not pick it off its description and
   * act — while the tool still loads it, so `/name` keeps working. None of the
   * bundled skills carries the flag, so it is written into the personal-skills
   * root the suite already isolates.
   */
  it('hides disable-model-invocation skills from the prompt but still loads them', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const { installMarketplacePackage } = await import('@main/marketplace/install')
    await installMarketplacePackage({ source: 'bundled', target: 'repo-onboarding' })

    const personalRoot = join(USER_DATA, 'personal-skills', 'user-invoked-only')
    mkdirSync(personalRoot, { recursive: true })
    writeFileSync(
      join(personalRoot, 'SKILL.md'),
      `---
name: user-invoked-only
description: A user-invoked skill. Use when the user types /user-invoked-only.
disable-model-invocation: true
metadata:
  version: "1.0.0"
---

## Instructions

Only run when the user asks.
`
    )
    const { setPersonalSkillsRootForTests } = await import('@main/agent/skills/local')
    setPersonalSkillsRootForTests(join(USER_DATA, 'personal-skills'))

    const skillsMod = await import('@main/agent/skills')
    const enabled = skillsMod.loadEnabledSkills()
    expect(enabled.find((s) => s.name === 'user-invoked-only')?.modelInvocable).toBe(false)
    expect(enabled.find((s) => s.name === 'repo-onboarding')?.modelInvocable).toBe(true)

    const section = skillsMod.buildSkillsSection(enabled)
    expect(section).toContain('repo-onboarding')
    expect(section).not.toContain('user-invoked-only')

    // Hidden from the menu, not from the tool: `/user-invoked-only` still works.
    expect(skillsMod.findEnabledSkillByName('user-invoked-only')?.name).toBe('user-invoked-only')
    const { toolSkill } = await import('@main/agent/tools/skill')
    expect(toolSkill(USER_DATA, 'user-invoked-only')).toContain('## Instructions')
  })
})
