/**
 * The run loop rebuilds the skills and plugin-rules prompt sections every step.
 * Unchanged marketplace/plugin files must not be re-read, the sections must
 * stay byte-identical, and an edited file must show up on the next build.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, mkdirSync, rmSync, readFileSync as readText, writeFileSync } from 'fs'
import { join } from 'path'

const { USER_DATA, reads } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { join: j } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  return {
    USER_DATA: mkdtempSync(j(tmpdir(), 'vyotiq-skills-cache-')),
    reads: { byPath: [] as string[] }
  }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const p = String(path).replace(/\\/g, '/')
    if (p.includes('/marketplace/packages/')) reads.byPath.push(p)
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})
vi.mock('electron', () => ({
  app: {
    getPath: () => USER_DATA,
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))
vi.mock('@main/marketplace/indexStore', () => ({
  readMarketplaceIndex: () => ({
    schemaVersion: 1,
    items: [
      { id: 'review-code', kind: 'skill', enabled: true, version: '1.0.0', packagePath: 'review-code/1.0.0' },
      { id: 'quality', kind: 'plugin', enabled: true, version: '1.0.0', packagePath: 'quality/1.0.0' }
    ]
  })
}))

import { buildSkillsSection, loadEnabledSkills, loadPluginRules } from '@main/agent/skills'
import { setPersonalSkillsRootForTests } from '@main/agent/skills/local'

const packages = join(USER_DATA, 'marketplace', 'packages')
const reviewSkill = join(packages, 'review-code', '1.0.0', 'SKILL.md')

function sections(): string {
  return `${buildSkillsSection(loadEnabledSkills(null, null))}\n${loadPluginRules(null)}`
}

beforeAll(() => {
  const bundled = join(process.cwd(), 'resources', 'marketplace', 'packages')
  for (const id of ['review-code', 'quality']) {
    mkdirSync(join(packages, id), { recursive: true })
    cpSync(join(bundled, id), join(packages, id, '1.0.0'), { recursive: true })
  }
  setPersonalSkillsRootForTests(join(USER_DATA, 'personal-skills'))
})

afterAll(() => {
  setPersonalSkillsRootForTests(null)
  rmSync(USER_DATA, { recursive: true, force: true })
})

beforeEach(() => {
  reads.byPath.length = 0
})

describe('skills and plugin-rules sections', () => {
  it('re-reads nothing on a rebuild when no file changed, and matches byte for byte', () => {
    const first = sections()
    expect(first).toContain('review-code')
    expect(first).toContain('plugin-rule:quality/rules/quality.md')
    expect(reads.byPath.length).toBeGreaterThan(0)

    reads.byPath.length = 0
    const second = sections()
    expect(second).toBe(first)
    expect(reads.byPath).toEqual([])
  })

  it('picks up an edited SKILL.md on the next build', () => {
    sections()
    const original = readText(reviewSkill, 'utf8')
    writeFileSync(
      reviewSkill,
      original.replace(/^description: .*$/m, 'description: Edited description for the cache test.')
    )
    try {
      expect(sections()).toContain('Edited description for the cache test.')
    } finally {
      writeFileSync(reviewSkill, original)
    }
  })
})
