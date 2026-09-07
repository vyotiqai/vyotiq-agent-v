/**
 * Smoke: Agent Skills alignment against real bundled packages (isolated temp userData).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const REPO = process.cwd()
const PACKAGES = join(REPO, 'resources', 'marketplace', 'packages')
const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-skills-smoke-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? USER_DATA : tmpdir()),
    getAppPath: () => REPO,
    isPackaged: false
  }
}))

describe('skills smoke (bundled + isolated marketplace)', () => {
  let skillDirs: string[] = []

  beforeAll(async () => {
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
    mkdirSync(join(USER_DATA, 'personal-skills'), { recursive: true })
    const { setPersonalSkillsRootForTests } = await import('@main/agent/skills/local')
    setPersonalSkillsRootForTests(join(USER_DATA, 'personal-skills'))
    const catalog = JSON.parse(
      readFileSync(join(REPO, 'resources', 'marketplace', 'catalog.json'), 'utf8')
    ) as { packages: Array<{ id: string; kind: string }> }
    skillDirs = catalog.packages
      .filter((pkg) => pkg.kind === 'skill')
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
    expect(skillDirs.length).toBe(11)
    for (const dir of skillDirs) {
      expect(existsSync(join(dir, 'SKILL.md')), dir).toBe(true)
    }
  })

  it('bundles the workflow pack plus UI/API skills and the four plugins', () => {
    const catalog = JSON.parse(
      readFileSync(join(REPO, 'resources', 'marketplace', 'catalog.json'), 'utf8')
    ) as { packages: Array<{ id: string; kind: string }> }
    const skillIds = catalog.packages
      .filter((pkg) => pkg.kind === 'skill')
      .map((pkg) => pkg.id)
      .sort()
    expect(skillIds).toEqual([
      'accessibility',
      'api-design',
      'create-skill',
      'explain-code',
      'fix-bug',
      'frontend-design',
      'goal',
      'implement-feature',
      'persona-builder',
      'review-code',
      'write-tests'
    ])
    expect(catalog.packages.filter((pkg) => pkg.kind === 'plugin').map((p) => p.id).sort()).toEqual([
      'devtools',
      'electron-app',
      'quality',
      'shipping'
    ])
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
      expect(parsed.body.trim().length).toBeGreaterThan(40)
      expect(parsed.body).toMatch(/## Instructions/i)
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
})
