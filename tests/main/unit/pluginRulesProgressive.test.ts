import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? (globalThis as { __ud?: string }).__ud! : tmpdir()),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

describe('loadPluginRules progressive disclosure', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'vyotiq-plugin-rules-'))
    ;(globalThis as { __ud?: string }).__ud = userData
    mkdirSync(join(userData, 'marketplace', 'packages', 'quality', '1.0.0', 'rules'), {
      recursive: true
    })
    writeFileSync(
      join(userData, 'marketplace', 'packages', 'quality', '1.0.0', 'vyotiq.plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'plugin',
        id: 'quality',
        name: 'Quality',
        version: '1.0.0',
        description: 'Quality plugin',
        mcp: [],
        skills: [],
        rules: ['rules/quality.md']
      })
    )
    writeFileSync(
      join(userData, 'marketplace', 'packages', 'quality', '1.0.0', 'rules', 'quality.md'),
      '# Quality conventions\n\n- Lead with highest-severity findings first.\n- Prefer concrete fixes.\n'
    )
    writeFileSync(
      join(userData, 'marketplace', 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        items: [
          {
            id: 'quality',
            kind: 'plugin',
            name: 'Quality',
            version: '1.0.0',
            description: 'Quality plugin',
            enabled: true,
            installSource: 'path',
            packagePath: 'quality/1.0.0',
            installedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    )
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('emits metadata only and loads full body via Skill', async () => {
    const skills = await import('@main/agent/skills')
    const section = skills.loadPluginRules()
    expect(section).toContain('<plugin_rules>')
    expect(section).toContain('plugin-rule:quality/rules/quality.md')
    expect(section).toContain('Quality conventions')
    expect(section).not.toContain('Lead with highest-severity')

    const rule = skills.findPluginRuleById('plugin-rule:quality/rules/quality.md')
    expect(rule).toBeTruthy()
    const body = skills.loadPluginRuleBody(rule!)
    expect(body).toContain('Lead with highest-severity findings first')

    vi.spyOn(skills, 'findEnabledSkillByName').mockReturnValue(undefined)
    const { toolSkill } = await import('@main/agent/tools/skill')
    const viaTool = toolSkill(userData, 'plugin-rule:quality/rules/quality.md')
    expect(viaTool).toContain('Lead with highest-severity')
  })
})
