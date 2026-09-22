/**
 * Smoke: Agent Skills alignment against real bundled packages (isolated temp userData).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const REPO = process.cwd()
const PACKAGES = join(REPO, 'resources', 'marketplace', 'packages')
const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-skills-smoke-'))

/**
 * Publisher on the skills we author. The house template below (## Instructions,
 * the when-to-use / output contract) is a rule about how *we* write a skill, so
 * it is asserted over these only. Vendored third-party skills ship as their
 * author wrote them — rewriting one to our headings would be a fork, and the
 * agent-facing contract they actually have to meet (parseable frontmatter, a
 * name that matches the package id, a non-empty body) is asserted over every
 * bundled skill regardless of who wrote it.
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

  it('finds the workflow skills plus UI/API skills with SKILL.md', () => {
    expect(firstPartyDirs.length).toBe(22)
    for (const dir of skillDirs) {
      expect(existsSync(join(dir, 'SKILL.md')), dir).toBe(true)
    }
  })

  it('bundles the workflow pack plus UI/API skills and the four plugins', () => {
    const skillIds = catalogPackages()
      .filter((pkg) => pkg.kind === 'skill' && pkg.publisher === FIRST_PARTY)
      .map((pkg) => pkg.id)
      .sort()
    expect(skillIds).toEqual([
      'accessibility',
      'analyze-api',
      'api-design',
      'create-skill',
      'create-teammate',
      // Recurring-loop skills: each spans two connected tools on a cadence.
      'dependency-upgrade',
      'docs',
      'explain-code',
      'fix-bug',
      'flake-hunter',
      'frontend-design',
      'goal',
      'implement-feature',
      'incident-triage',
      'persona-builder',
      'pr-review-reply',
      'refactor',
      'release-notes',
      'repo-onboarding',
      'review-code',
      'standup-digest',
      'write-tests'
    ])
    expect(catalogPackages().filter((pkg) => pkg.kind === 'plugin').map((p) => p.id).sort()).toEqual([
      'devtools',
      'electron-app',
      'quality',
      'shipping'
    ])
  })

  /**
   * Vendored from github.com/mattpocock/skills (MIT — see NOTICE). Listed here
   * so re-syncing upstream is a visible edit: a skill that quietly disappears
   * from the catalog, or a new one that arrives without anyone approving it on
   * the website, fails here rather than shipping.
   */
  it('bundles the vendored third-party skills under their author', () => {
    const vendored = catalogPackages()
      .filter((pkg) => pkg.kind === 'skill' && pkg.publisher !== FIRST_PARTY)
      .map((pkg) => `${pkg.publisher}/${pkg.id}`)
      .sort()
    expect(vendored).toEqual([
      'Matt Pocock/ask-matt',
      'Matt Pocock/codebase-design',
      'Matt Pocock/diagnosing-bugs',
      'Matt Pocock/domain-modeling',
      'Matt Pocock/grill-me',
      'Matt Pocock/grill-with-docs',
      'Matt Pocock/grilling',
      'Matt Pocock/handoff',
      'Matt Pocock/implement',
      'Matt Pocock/improve-codebase-architecture',
      'Matt Pocock/prototype',
      'Matt Pocock/research',
      'Matt Pocock/resolving-merge-conflicts',
      // Upstream calls this one `code-review`; that name belongs to the skill
      // nested in our own `quality` plugin, and the loader resolves by name.
      'Matt Pocock/review-changes',
      'Matt Pocock/setup-matt-pocock-skills',
      'Matt Pocock/setup-pre-commit',
      'Matt Pocock/tdd',
      'Matt Pocock/teach',
      'Matt Pocock/to-questionnaire',
      'Matt Pocock/to-spec',
      'Matt Pocock/to-tickets',
      'Matt Pocock/triage',
      'Matt Pocock/wait-what',
      'Matt Pocock/wayfinder',
      'Matt Pocock/wizard',
      'Matt Pocock/writing-for-agents'
    ])
  })

  /**
   * A vendored skill is copied text, so the licence has to travel with it:
   * `resources/` is what gets installed into userData, and NOTICE does not
   * follow the file there.
   */
  it('keeps the licence in every vendored skill frontmatter', async () => {
    const { parseSkillFrontmatter } = await import('@main/agent/skills/parse')
    const vendored = catalogPackages().filter(
      (pkg) => pkg.kind === 'skill' && pkg.publisher !== FIRST_PARTY
    )
    for (const pkg of vendored) {
      const parsed = parseSkillFrontmatter(readFileSync(join(PACKAGES, pkg.id, 'SKILL.md'), 'utf8'))
      expect(parsed.license, pkg.id).toBe('MIT')
    }
  })

  /**
   * The bug this guards: `grill-me`'s whole body is "Call the Skill tool with
   * grilling". Installed on its own it loaded, instructed the agent to call a
   * sibling nobody had installed, and the Skill tool threw. Vendoring an
   * interlinked suite one card per skill is what made that reachable, so every
   * such handoff has to be a declared dependency the installer can follow.
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
    const contracts: Record<string, string[]> = {
      'implement-feature': ['## when to use', '## when not to use', '## output', 'fix-bug', 'review-code'],
      'fix-bug': ['## when to use', '## when not to use', '## output', 'implement-feature', 'review-code'],
      'review-code': ['## when to use', '## when not to use', '## output', 'implement-feature', 'fix-bug'],
      'write-tests': ['## when to use', '## when not to use', '## output', 'implement-feature', 'fix-bug'],
      'explain-code': ['## when to use', '## when not to use', '## output', 'implement-feature', 'fix-bug'],
      'create-skill': [
        '## before you begin: gather requirements',
        '## skill creation workflow',
        '## final checklist',
        'create a skill only when',
        '.vyotiq/skills',
        '/create-skill personal'
      ],
      'create-teammate': [
        '## instructions',
        '## verify',
        '## output',
        '## when not to use this skill',
        // The judgement the skill exists to make: a teammate is not an instance,
        // and most work is neither.
        'spawn_agent_instance',
        'teammate_task',
        'retires the id forever'
      ],
      goal: [
        '## when to use',
        '## when not to use',
        'create_goal',
        'update_goal',
        'never pause',
        '/loop'
      ]
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
      'accessibility',
      'api-design',
      'explain-code',
      'fix-bug',
      'frontend-design',
      'goal',
      'implement-feature',
      'persona-builder',
      'review-code',
      'create-skill',
      'create-teammate',
      'write-tests'
    ]
    for (const id of standalone) {
      const detected = detectPackageAt(join(PACKAGES, id))
      expect(detected.kind).toBe('skill')
      expect(detected.id).toBeTruthy()
      expect(detected.version).toBeTruthy()
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
    expect(section).toContain('implement-feature')
    expect(section).not.toMatch(/## Instructions/)
    expect(section).not.toContain('duplicate plugin copy')
    const nameHits = section.match(new RegExp(`\\*\\*${skills[0]!.name}\\*\\*`, 'g'))
    expect(nameHits?.length).toBe(1)
  })

  it('Skill tool loads real implement-feature body and blocks escape', async () => {
    const skillRoot = join(PACKAGES, 'implement-feature')
    const skillsMod = await import('@main/agent/skills')
    const parsed = (await import('@main/agent/skills/parse')).parseSkillFrontmatter(
      readFileSync(join(skillRoot, 'SKILL.md'), 'utf8')
    )
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockReturnValue({
      id: 'implement-feature',
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      root: skillRoot,
      skillPath: join(skillRoot, 'SKILL.md'),
      source: 'skill'
    })
    const { toolSkill } = await import('@main/agent/tools/skill')
    const loaded = toolSkill(USER_DATA, 'implement-feature')
    expect(loaded).toContain('architecture')
    expect(loaded).toMatch(/skill:\s*implement-feature/i)
    expect(() => toolSkill(USER_DATA, 'implement-feature', '../settings.json')).toThrow()
  })

  it('TOOL_REGISTRY exposes Skill as a builtin', async () => {
    const { AGENT_TOOLS, BUILTIN_TOOL_NAMES } = await import('@main/agent/schemas/tools')
    expect([...BUILTIN_TOOL_NAMES]).toContain('Skill')
    const skill = AGENT_TOOLS.find((t) => t.name === 'Skill')
    expect(skill).toBeTruthy()
    expect(skill!.description.toLowerCase()).toMatch(/skill/)
  })

  it('installs implement-feature into temp marketplace and loadEnabledSkills finds it', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    const skillsMod = await import('@main/agent/skills')
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockRestore()

    const result = await installMarketplacePackage({
      source: 'bundled',
      target: 'implement-feature'
    })
    expect(result.item.kind).toBe('skill')
    expect(result.item.id).toBe('implement-feature')
    expect(result.item.enabled).toBe(true)

    const enabled = skillsMod.loadEnabledSkills()
    const review = enabled.find((s) => s.name === 'implement-feature')
    expect(review).toBeTruthy()
    expect(existsSync(review!.skillPath)).toBe(true)

    const section = skillsMod.buildSkillsSection(enabled)
    expect(section).toContain('implement-feature')
    expect(section).toContain('`Skill` tool')
    expect(section).not.toMatch(/## Instructions/)

    const found = skillsMod.findEnabledSkillByName('implement-feature')
    expect(found?.name).toBe('implement-feature')

    const body = (await import('@main/agent/tools/skill')).toolSkill(USER_DATA, 'implement-feature')
    expect(body).toContain('architecture')
  })

  /**
   * The vendored skills are the first bundled packages that carry reference
   * files beside SKILL.md, and their bodies link to them by relative path. A
   * copy that dropped them would install a skill whose instructions point at
   * nothing, so assert the whole directory survives the install and that the
   * Skill tool serves a file out of it.
   */
  it('installs a vendored skill with its reference files and serves them', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    const result = await installMarketplacePackage({ source: 'bundled', target: 'tdd' })
    expect(result.item.kind).toBe('skill')

    const { resolveInstalledPackageRoot } = await import('@main/marketplace/paths')
    const root = resolveInstalledPackageRoot(result.item.packagePath)
    for (const file of ['SKILL.md', 'tests.md', 'mocking.md']) {
      expect(existsSync(join(root, file)), file).toBe(true)
    }

    const { toolSkill } = await import('@main/agent/tools/skill')
    // SKILL.md links to these two, and loading the skill advertises them.
    const loaded = toolSkill(USER_DATA, 'tdd')
    expect(loaded).toContain('tests.md')
    expect(loaded).toContain('mocking.md')

    const file = toolSkill(USER_DATA, 'tdd', 'tests.md')
    expect(file).toContain('tdd / tests.md')
    expect(file.length).toBeGreaterThan(200)

    expect(() => toolSkill(USER_DATA, 'tdd', '../../settings.json')).toThrow()
  })

  /**
   * End to end on the reported failure: install the one card the user clicked
   * and the handoff target has to come with it, enabled and loadable.
   */
  it('installs the skills a vendored skill hands off to', async () => {
    const { writeMarketplaceIndex, readMarketplaceIndex } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    const result = await installMarketplacePackage({ source: 'bundled', target: 'grill-me' })
    expect(result.item.id).toBe('grill-me')
    expect(result.dependencies).toEqual(['grilling'])

    const installed = readMarketplaceIndex().items.map((i) => i.id).sort()
    expect(installed).toEqual(['grill-me', 'grilling'])

    // The instruction inside grill-me's body now resolves.
    const { toolSkill } = await import('@main/agent/tools/skill')
    expect(toolSkill(USER_DATA, 'grill-me')).toContain('grilling')
    expect(toolSkill(USER_DATA, 'grilling')).toContain('frontier')
  })

  it('installs transitive dependencies once and leaves existing installs alone', async () => {
    const { writeMarketplaceIndex, readMarketplaceIndex } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const { installMarketplacePackage } = await import('@main/marketplace/install')

    // codebase-design arrives under tdd; installing `implement` afterwards must
    // not reinstall it, and must not resurrect a disabled one.
    await installMarketplacePackage({ source: 'bundled', target: 'tdd' })
    const { setInstalledEnabled } = await import('@main/marketplace/indexStore')
    setInstalledEnabled('codebase-design', false)

    const result = await installMarketplacePackage({ source: 'bundled', target: 'implement' })
    // tdd was already there, so only review-changes is new — codebase-design is
    // reached through tdd and stays untouched.
    expect(result.dependencies).toEqual(['review-changes'])

    const items = readMarketplaceIndex().items
    expect(items.map((i) => i.id).sort()).toEqual([
      'codebase-design',
      'implement',
      'review-changes',
      'tdd'
    ])
    expect(items.find((i) => i.id === 'codebase-design')?.enabled).toBe(false)
  })

  /**
   * ask-matt is the index over the whole suite: every row of its map tells the
   * agent to run another skill, so installing it has to bring the suite. The
   * biggest fan-out in the catalog, and the one most likely to trip a limit.
   */
  it('installs the whole suite behind the index skill', async () => {
    const { writeMarketplaceIndex, readMarketplaceIndex } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const { installMarketplacePackage } = await import('@main/marketplace/install')

    const declared = catalogPackages().find((p) => p.id === 'ask-matt')?.dependsOn ?? []
    expect(declared.length).toBeGreaterThan(20)

    const result = await installMarketplacePackage({ source: 'bundled', target: 'ask-matt' })
    expect(result.dependencies?.sort()).toEqual([...declared].sort())

    const skillsMod = await import('@main/agent/skills')
    const byName = new Map(skillsMod.loadEnabledSkills().map((s) => [s.name, s]))
    for (const id of declared) expect(byName.has(id), id).toBe(true)
    expect(readMarketplaceIndex().items).toHaveLength(declared.length + 1)
  })

  /**
   * The reported failure was an install that predates `dependsOn`: grill-me on
   * its own, with nothing to hand off to. Startup has to heal it, or the fix
   * only reaches people who install the skill again.
   */
  it('restores dependencies missing from an install made before they were declared', async () => {
    const { writeMarketplaceIndex, readMarketplaceIndex, removeInstalledItem } = await import(
      '@main/marketplace/indexStore'
    )
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const { installMarketplacePackage, repairMissingPackageDependencies } = await import(
      '@main/marketplace/install'
    )
    await installMarketplacePackage({ source: 'bundled', target: 'grill-me' })
    // Reproduce the old state: the dependent package, none of its handoffs.
    removeInstalledItem('grilling')
    expect(readMarketplaceIndex().items.map((i) => i.id)).toEqual(['grill-me'])

    expect(await repairMissingPackageDependencies()).toEqual(['grilling'])
    expect(readMarketplaceIndex().items.map((i) => i.id).sort()).toEqual(['grill-me', 'grilling'])

    // Idempotent: a second pass has nothing left to do.
    expect(await repairMissingPackageDependencies()).toEqual([])
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
    expect(() => toolSkill(USER_DATA, 'grilling')).toThrow(/not installed/i)
    expect(() => toolSkill(USER_DATA, 'grilling')).not.toThrow(/disabled/i)

    const { installMarketplacePackage } = await import('@main/marketplace/install')
    await installMarketplacePackage({ source: 'bundled', target: 'grilling' })
    setInstalledEnabled('grilling', false)
    expect(() => toolSkill(USER_DATA, 'grilling')).toThrow(/installed but disabled/i)

    // Not a package at all.
    expect(() => toolSkill(USER_DATA, 'no-such-skill-anywhere')).toThrow(/Unknown skill/i)
  })

  /**
   * Upstream marks the interview entry points user-invoked. Dropping the flag
   * left the agent free to pick `grill-me` off its description and open an
   * interview nobody asked for.
   */
  it('hides disable-model-invocation skills from the prompt but still loads them', async () => {
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
    const { installMarketplacePackage } = await import('@main/marketplace/install')
    await installMarketplacePackage({ source: 'bundled', target: 'grill-me' })

    const skillsMod = await import('@main/agent/skills')
    const enabled = skillsMod.loadEnabledSkills()
    expect(enabled.find((s) => s.name === 'grill-me')?.modelInvocable).toBe(false)
    expect(enabled.find((s) => s.name === 'grilling')?.modelInvocable).toBe(true)

    const section = skillsMod.buildSkillsSection(enabled)
    expect(section).toContain('grilling')
    expect(section).not.toContain('grill-me')

    // Hidden from the menu, not from the tool: `/grill-me` still has to work.
    expect(skillsMod.findEnabledSkillByName('grill-me')?.name).toBe('grill-me')
    const { toolSkill } = await import('@main/agent/tools/skill')
    expect(toolSkill(USER_DATA, 'grill-me')).toContain('grilling')
  })
})
