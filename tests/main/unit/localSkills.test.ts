import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-local-skills-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? USER_DATA : tmpdir()),
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  BrowserWindow: {
    getAllWindows: () => []
  },
  shell: {
    openPath: vi.fn(async () => '')
  }
}))

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---
name: ${name}
description: ${description}
metadata:
  version: "1.0.0"
---

# ${name}

Do the ${name} workflow.
`
  )
}

describe('local filesystem skills', () => {
  let workspace: string
  let personal: string

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-ws-skills-'))
    personal = mkdtempSync(join(tmpdir(), 'vyotiq-home-skills-'))
    const { setPersonalSkillsRootForTests, clearLocalSkillsCache } = await import(
      '@main/agent/skills/local'
    )
    setPersonalSkillsRootForTests(personal)
    clearLocalSkillsCache()
    mkdirSync(join(USER_DATA, 'marketplace', 'packages'), { recursive: true })
    const { writeMarketplaceIndex } = await import('@main/marketplace/indexStore')
    writeMarketplaceIndex({ schemaVersion: 1, items: [] })
  })

  afterEach(async () => {
    const { setPersonalSkillsRootForTests, clearLocalSkillsCache } = await import(
      '@main/agent/skills/local'
    )
    setPersonalSkillsRootForTests(null)
    clearLocalSkillsCache()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(personal, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('scans project, cursor, and personal skills with vyotiq winning name collisions', async () => {
    writeSkill(
      join(workspace, '.vyotiq', 'skills', 'ship'),
      'ship',
      'Vyotiq project ship skill for local discovery tests.'
    )
    writeSkill(
      join(workspace, '.cursor', 'skills', 'ship'),
      'ship',
      'Cursor project ship skill that should lose to vyotiq.'
    )
    writeSkill(
      join(workspace, '.cursor', 'skills', 'audit'),
      'audit',
      'Cursor-only audit skill for local discovery tests.'
    )
    writeSkill(
      join(personal, 'greet'),
      'greet',
      'Personal greet skill reusable across projects.'
    )

    const { loadLocalSkills, isSkillRelatedRelPath } = await import('@main/agent/skills/local')
    const loaded = loadLocalSkills(workspace)
    expect(loaded.find((s) => s.name === 'ship')?.description).toMatch(/Vyotiq project/)
    expect(loaded.find((s) => s.name === 'ship')?.origin).toBe('vyotiq')
    expect(loaded.find((s) => s.name === 'audit')?.origin).toBe('cursor')
    expect(loaded.find((s) => s.name === 'greet')?.source).toBe('personal')

    const { loadEnabledSkills, findEnabledSkillByName } = await import('@main/agent/skills')
    const enabled = loadEnabledSkills(null, workspace)
    expect(enabled.some((s) => s.name === 'ship' && s.source === 'project')).toBe(true)
    expect(findEnabledSkillByName('greet', null, workspace)?.source).toBe('personal')

    const { toolSkill } = await import('@main/agent/tools/skill')
    expect(toolSkill(workspace, 'ship')).toContain('Do the ship workflow')
    expect(toolSkill(workspace, 'audit')).toContain('Do the audit workflow')

    expect(isSkillRelatedRelPath('.vyotiq/skills/ship/SKILL.md')).toBe(true)
    expect(isSkillRelatedRelPath('src/main/index.ts')).toBe(false)

    const { isRuleRelatedRelPath } = await import('@main/agent/context/rules')
    expect(isRuleRelatedRelPath('.vyotiq/rules/ops.md')).toBe(true)
    expect(isRuleRelatedRelPath('.cursor/rules/style.mdc')).toBe(true)
    expect(isRuleRelatedRelPath('AGENTS.md')).toBe(true)
    expect(isRuleRelatedRelPath('src/main/index.ts')).toBe(false)

    const { listLocalSkillItems } = await import('@main/agent/skills/local')
    expect(listLocalSkillItems(workspace).map((s) => s.name).sort()).toEqual([
      'audit',
      'greet',
      'ship'
    ])
  })

  it('skips invalid frontmatter and lists slash commands as ready', async () => {
    writeSkill(
      join(workspace, '.vyotiq', 'skills', 'ok-skill'),
      'ok-skill',
      'Valid project skill used to assert slash listing.'
    )
    mkdirSync(join(workspace, '.vyotiq', 'skills', 'broken'), { recursive: true })
    writeFileSync(join(workspace, '.vyotiq', 'skills', 'broken', 'SKILL.md'), 'no frontmatter\n')

    const { loadLocalSkills } = await import('@main/agent/skills/local')
    const loaded = loadLocalSkills(workspace)
    expect(loaded.map((s) => s.name)).toEqual(['ok-skill'])

    const { listSkillCommands, resolveSkillCommand } = await import(
      '@main/agent/slashCommands/skills'
    )
    const listed = await listSkillCommands(null, workspace)
    const local = listed.find((c) => c.trigger === 'ok-skill')
    expect(local?.availability).toBe('ready')
    expect(local?.id).toBe('skill:local:project:ok-skill')

    const resolved = resolveSkillCommand(local!.id, 'now', null, workspace)
    expect(resolved?.action).toBe('send')
    if (resolved?.action === 'send') {
      expect(resolved.message).toContain('ok-skill')
      expect(resolved.message).toContain('now')
    }
  })

  it('creates a project skill stub and unique slug', async () => {
    const { createLocalSkill } = await import('@main/agent/skills/local')
    const first = createLocalSkill({
      workspacePath: workspace,
      title: 'Release notes',
      scope: 'project'
    })
    expect(first.relativePath).toBe('.vyotiq/skills/release-notes/SKILL.md')
    expect(existsSync(first.path)).toBe(true)
    const parsed = readFileSync(first.path, 'utf8')
    expect(parsed).toContain('name: release-notes')
    expect(parsed).toMatch(/^---/)

    const second = createLocalSkill({
      workspacePath: workspace,
      title: 'Release notes',
      scope: 'project'
    })
    expect(second.relativePath).toBe('.vyotiq/skills/release-notes-2/SKILL.md')

    const personalSkill = createLocalSkill({
      title: 'house style',
      scope: 'personal'
    })
    expect(personalSkill.source).toBe('personal')
    expect(personalSkill.relativePath).toBe('~/.vyotiq/skills/house-style/SKILL.md')
    expect(existsSync(personalSkill.path)).toBe(true)
  })

  it('prefers a project skill over a marketplace skill with the same name', async () => {
    writeSkill(
      join(workspace, '.vyotiq', 'skills', 'review-code'),
      'review-code',
      'Local project review-code that should beat marketplace.'
    )
    const { loadEnabledSkills, dedupeSkillsByName } = await import('@main/agent/skills')
    const mixed = loadEnabledSkills(null, workspace)
    mixed.push({
      id: 'review-code',
      name: 'review-code',
      description: 'Marketplace copy',
      body: 'marketplace body',
      root: '/tmp/mkt',
      skillPath: '/tmp/mkt/SKILL.md',
      source: 'skill'
    })
    const unique = dedupeSkillsByName(mixed)
    const review = unique.find((s) => s.name === 'review-code')
    expect(review?.source).toBe('project')
    expect(review?.description).toMatch(/Local project/)
  })

  it('invalidates the local-skill cache after notifySkillsChanged', async () => {
    const skillDir = join(workspace, '.vyotiq', 'skills', 'cache-skill')
    writeSkill(skillDir, 'cache-skill', 'Original cache-skill description for fingerprint tests.')

    const { loadLocalSkills, clearLocalSkillsCache } = await import('@main/agent/skills/local')
    clearLocalSkillsCache()
    expect(loadLocalSkills(workspace).find((s) => s.name === 'cache-skill')?.description).toMatch(
      /Original cache-skill/
    )

    writeSkill(skillDir, 'cache-skill', 'Updated cache-skill description after the file rewrite.')
    expect(loadLocalSkills(workspace).find((s) => s.name === 'cache-skill')?.description).toMatch(
      /Original cache-skill/
    )

    const { notifySkillsChanged } = await import('@main/agent/skills/notify')
    notifySkillsChanged(workspace)
    expect(loadLocalSkills(workspace).find((s) => s.name === 'cache-skill')?.description).toMatch(
      /Updated cache-skill/
    )
  })

  it('createWorkspaceSkill writes a project stub without opening the OS editor', async () => {
    const { createWorkspaceSkill } = await import('@main/agent/slashCommands')
    const { shell } = await import('electron')
    const created = await createWorkspaceSkill(workspace, 'Release notes', 'project')
    expect(created.relativePath).toBe('.vyotiq/skills/release-notes/SKILL.md')
    expect(created.source).toBe('project')
    expect(existsSync(created.path)).toBe(true)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('createWorkspaceRule writes alwaysApply frontmatter without opening the OS editor', async () => {
    const { createWorkspaceRule } = await import('@main/agent/slashCommands')
    const { shell } = await import('electron')
    const created = await createWorkspaceRule(workspace, 'Release notes')
    expect(created.relativePath).toBe('.vyotiq/rules/release-notes.md')
    expect(existsSync(created.path)).toBe(true)
    const parsed = readFileSync(created.path, 'utf8')
    expect(parsed).toContain('alwaysApply: true')
    expect(parsed).toMatch(/^---/)
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('read/write/delete stay inside the skills root and rename on name change', async () => {
    const {
      createLocalSkill,
      readLocalSkillFile,
      writeLocalSkillFile,
      deleteLocalSkillFile,
      isAllowedLocalSkillPath
    } = await import('@main/agent/skills/local')
    const created = createLocalSkill({
      workspacePath: workspace,
      title: 'release notes',
      scope: 'project'
    })
    const loaded = readLocalSkillFile(created.path, workspace)
    expect(loaded.name).toBe('release-notes')
    expect(loaded.description).toMatch(/Describe this skill/)

    const escaped = join(workspace, 'src', 'secret', 'SKILL.md')
    mkdirSync(join(workspace, 'src', 'secret'), { recursive: true })
    writeFileSync(escaped, '---\nname: secret\ndescription: should not be writable from skills IPC.\n---\n')
    expect(isAllowedLocalSkillPath(escaped, workspace)).toBe(false)
    expect(() => readLocalSkillFile(escaped, workspace)).toThrow(/not a local skill/)
    expect(() =>
      writeLocalSkillFile({
        skillPath: escaped,
        content: loaded.content,
        workspacePath: workspace
      })
    ).toThrow(/not a local skill/)
    expect(() => deleteLocalSkillFile(escaped, workspace)).toThrow(/not a local skill/)

    const rewritten = writeLocalSkillFile({
      skillPath: created.path,
      content: `---
name: ship-notes
description: Rewritten project skill that ships release notes from the current workspace.
---

# Ship notes

Follow the ship-notes workflow for this repository.
`,
      workspacePath: workspace
    })
    expect(rewritten.name).toBe('ship-notes')
    expect(rewritten.relativePath).toBe('.vyotiq/skills/ship-notes/SKILL.md')
    expect(existsSync(created.path)).toBe(false)
    expect(existsSync(rewritten.skillPath)).toBe(true)
    expect(readFileSync(rewritten.skillPath, 'utf8')).toContain('name: ship-notes')

    expect(() =>
      writeLocalSkillFile({
        skillPath: rewritten.skillPath,
        content: `---
name: Bad Name
description: Invalid skill name should be rejected by frontmatter validation.
---

body
`,
        workspacePath: workspace
      })
    ).toThrow()

    deleteLocalSkillFile(rewritten.skillPath, workspace)
    expect(existsSync(rewritten.skillPath)).toBe(false)
  })

  it('does not rewrite a skill file when the rename target already exists', async () => {
    const { createLocalSkill, writeLocalSkillFile } = await import('@main/agent/skills/local')
    const created = createLocalSkill({
      workspacePath: workspace,
      title: 'release notes',
      scope: 'project'
    })
    writeSkill(
      join(workspace, '.vyotiq', 'skills', 'taken'),
      'taken',
      'Existing project skill that must keep its folder on a colliding rename.'
    )
    const before = readFileSync(created.path, 'utf8')
    expect(() =>
      writeLocalSkillFile({
        skillPath: created.path,
        content: `---
name: taken
description: Colliding rename must be rejected before the source file is rewritten.
---

# Taken

This body must not land in the original folder.
`,
        workspacePath: workspace
      })
    ).toThrow(/already exists/)
    expect(readFileSync(created.path, 'utf8')).toBe(before)
    expect(existsSync(join(workspace, '.vyotiq', 'skills', 'release-notes', 'SKILL.md'))).toBe(true)
  })

  it('allows personal skill writes without a workspace and rejects escapes', async () => {
    const {
      createLocalSkill,
      readLocalSkillFile,
      writeLocalSkillFile,
      isAllowedLocalSkillPath
    } = await import('@main/agent/skills/local')
    const created = createLocalSkill({
      title: 'house style',
      scope: 'personal'
    })
    const loaded = readLocalSkillFile(created.path, null)
    const rewritten = writeLocalSkillFile({
      skillPath: created.path,
      content: `---
name: house-style
description: Personal house style skill used across every workspace.
---

# House style

Prefer named exports.
`,
      workspacePath: null
    })
    expect(rewritten.name).toBe('house-style')
    expect(loaded.name).toBe('house-style')
    expect(readFileSync(rewritten.skillPath, 'utf8')).toContain('Prefer named exports')

    const escaped = join(personal, '..', 'secret', 'SKILL.md')
    mkdirSync(join(personal, '..', 'secret'), { recursive: true })
    writeFileSync(
      escaped,
      '---\nname: secret\ndescription: should not be writable from skills IPC.\n---\n'
    )
    expect(isAllowedLocalSkillPath(escaped, null)).toBe(false)
    expect(() =>
      writeLocalSkillFile({
        skillPath: escaped,
        content: loaded.content,
        workspacePath: null
      })
    ).toThrow(/not a local skill/)
  })
})
