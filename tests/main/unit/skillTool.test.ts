import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

describe('toolSkill', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-skill-tool-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('loads SKILL.md body and blocks path escape', async () => {
    const skillRoot = join(dir, 'code-review')
    mkdirSync(join(skillRoot, 'references'), { recursive: true })
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      `---
name: code-review
description: Review code when asked for a structured review.
metadata:
  version: "1.0.0"
---

# Code review

Do a thorough review.
`
    )
    writeFileSync(join(skillRoot, 'references', 'NOTES.md'), 'Extra notes.\n')

    const skillsMod = await import('@main/agent/skills')
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockReturnValue({
      id: 'code-review',
      name: 'code-review',
      description: 'Review code when asked for a structured review.',
      body: '# Code review\n\nDo a thorough review.',
      root: skillRoot,
      skillPath: join(skillRoot, 'SKILL.md'),
      source: 'skill'
    })

    const { toolSkill } = await import('@main/agent/tools/skill')
    const loaded = toolSkill(dir, 'code-review')
    expect(loaded).toContain('Do a thorough review')
    expect(loaded).toContain('references/NOTES.md')

    const notes = toolSkill(dir, 'code-review', 'references/NOTES.md')
    expect(notes).toContain('Extra notes')

    expect(() => toolSkill(dir, 'code-review', '../outside.txt')).toThrow(/Unsafe|escapes/i)
  })

  it('listSkillBundledFiles skips symlink entries', async () => {
    const { symlinkSync } = await import('fs')
    const skillRoot = join(dir, 'with-link')
    const outside = join(dir, 'outside-secret')
    mkdirSync(skillRoot, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'LEAK.txt'), 'secret\n')
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      `---
name: with-link
description: Skill with a symlink trap.
---

# Body
`
    )
    writeFileSync(join(skillRoot, 'safe.txt'), 'ok\n')
    try {
      symlinkSync(outside, join(skillRoot, 'trap'), 'junction')
    } catch {
      // Skip on environments that cannot create junctions/symlinks.
      return
    }

    const { listSkillBundledFiles } = await import('@main/agent/skills')
    const listed = listSkillBundledFiles(skillRoot)
    expect(listed).toContain('safe.txt')
    expect(listed.some((p) => p.includes('LEAK') || p.includes('trap'))).toBe(false)
  })
})
