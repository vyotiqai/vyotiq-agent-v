import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
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

  it('never lists or serves binary bundled files, and caps text reads', async () => {
    const skillRoot = join(dir, 'review-code')
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      `---
name: review-code
description: Review code.
---

# Review
`
    )
    // Bundled packages ship the Word source their SKILL.md is generated from.
    copyFileSync(
      join(process.cwd(), 'resources/marketplace/packages/review-code/SKILL.md.docx'),
      join(skillRoot, 'SKILL.md.docx')
    )
    writeFileSync(join(skillRoot, 'blob.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    writeFileSync(join(skillRoot, 'BIG.md'), 'x'.repeat(200_000))

    const skillsMod = await import('@main/agent/skills')
    vi.spyOn(skillsMod, 'findEnabledSkillByName').mockReturnValue({
      id: 'review-code',
      name: 'review-code',
      description: 'Review code.',
      body: '# Review',
      root: skillRoot,
      skillPath: join(skillRoot, 'SKILL.md'),
      source: 'skill',
      modelInvocable: true
    })

    const { toolSkill, SKILL_FILE_READ_CAP } = await import('@main/agent/tools/skill')
    const body = toolSkill(dir, 'review-code')
    expect(body).not.toContain('SKILL.md.docx')
    expect(body).toContain('- BIG.md')

    expect(() => toolSkill(dir, 'review-code', 'SKILL.md.docx')).toThrow(/binary/)
    expect(() => toolSkill(dir, 'review-code', 'blob.dat')).toThrow(/binary/)

    const big = toolSkill(dir, 'review-code', 'BIG.md')
    expect(big).toContain(`showing ${SKILL_FILE_READ_CAP} of 200000 bytes`)
    expect(big.length).toBeLessThan(SKILL_FILE_READ_CAP + 1_000)
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
