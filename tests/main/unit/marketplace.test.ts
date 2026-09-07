import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getAppPath: () => process.cwd(),
    isPackaged: false
  }
}))

import { McpServerSchema, VyotiqMcpManifestSchema, McpStartOAuthRequestSchema } from '@shared/ipc'
import {
  GITHUB_MCP_ID,
  GMAIL_MCP_ID,
  GOOGLE_CALENDAR_MCP_ID,
  GOOGLE_DRIVE_MCP_ID,
  HOSTED_APP_MCP_IDS,
  isHostedAppMcpId
} from '@shared/mcpApps'
import { effectiveMarketplaceEnabled } from '@shared/domain/marketplaceEnablement'
import { mcpServerConfigKey } from '@main/agent/mcp'
import { parseSkillFrontmatter } from '@main/agent/skills/parse'
import { detectPackageAt, copyPackageIntoStore } from '@main/marketplace/install'
import { buildSkillsSection, type LoadedSkill } from '@main/agent/skills'

describe('McpServerSchema transport migration', () => {
  it('defaults missing transport to stdio', () => {
    const parsed = McpServerSchema.parse({
      id: 'fs',
      name: 'Filesystem',
      command: 'npx',
      enabled: true
    })
    expect(parsed.transport).toBe('stdio')
    expect(parsed.command).toBe('npx')
  })

  it('requires url for http transport', () => {
    const result = McpServerSchema.safeParse({
      id: 'remote',
      name: 'Remote',
      transport: 'http',
      enabled: true
    })
    expect(result.success).toBe(false)
  })

  it('accepts http with url', () => {
    const parsed = McpServerSchema.parse({
      id: 'remote',
      name: 'Remote',
      transport: 'http',
      url: 'https://example.com/mcp',
      enabled: true
    })
    expect(parsed.transport).toBe('http')
    expect(parsed.url).toBe('https://example.com/mcp')
  })

  it('accepts oauth client id and this-workspace auth scope', () => {
    const parsed = McpServerSchema.parse({
      id: 'gmail',
      name: 'Gmail',
      transport: 'http',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      enabled: true,
      oauthClientId: 'google-client.apps.googleusercontent.com',
      authScope: 'this-workspace',
      authWorkspacePath: 'C:\\ws'
    })
    expect(parsed.oauthClientId).toBe('google-client.apps.googleusercontent.com')
    expect(parsed.authScope).toBe('this-workspace')
    expect(parsed.authWorkspacePath).toBe('C:\\ws')
  })

  it('accepts googleAccess on MCP servers and start-OAuth payload', () => {
    const parsed = McpServerSchema.parse({
      id: 'gmail',
      name: 'Gmail',
      transport: 'http',
      url: 'https://gmailmcp.googleapis.com/mcp/v1',
      enabled: true,
      googleAccess: 'read'
    })
    expect(parsed.googleAccess).toBe('read')
    expect(
      McpStartOAuthRequestSchema.parse({
        serverId: 'gmail',
        authScope: 'all-workspaces',
        googleAccess: 'read-write'
      }).googleAccess
    ).toBe('read-write')
  })
})

describe('mcpServerConfigKey', () => {
  it('includes transport and url in fingerprint', () => {
    const a = mcpServerConfigKey({
      transport: 'http',
      url: 'https://a.example/mcp',
      headers: { Authorization: 'Bearer x' }
    })
    const b = mcpServerConfigKey({
      transport: 'http',
      url: 'https://b.example/mcp',
      headers: { Authorization: 'Bearer x' }
    })
    expect(a).not.toBe(b)
  })
})

describe('effectiveMarketplaceEnabled', () => {
  it('uses workspace override when present', () => {
    expect(
      effectiveMarketplaceEnabled('fs', true, { mcp: { fs: false } }, 'mcp')
    ).toBe(false)
    expect(
      effectiveMarketplaceEnabled('fs', false, { mcp: { fs: true } }, 'mcp')
    ).toBe(true)
  })

  it('falls back to global when no override', () => {
    expect(effectiveMarketplaceEnabled('fs', true, {}, 'mcp')).toBe(true)
    expect(effectiveMarketplaceEnabled('fs', false, undefined, 'skills')).toBe(false)
  })
})

describe('VyotiqMcpManifestSchema', () => {
  it('parses stdio manifest', () => {
    const m = VyotiqMcpManifestSchema.parse({
      schemaVersion: 1,
      kind: 'mcp',
      id: 'filesystem',
      name: 'Filesystem',
      version: '1.0.0',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
    })
    expect(m.id).toBe('filesystem')
  })
})

describe('parseSkillFrontmatter', () => {
  it('parses SKILL.md with nested metadata and legacy version', () => {
    const raw = `---
name: code-review
description: Review code carefully when asked for a structured review.
version: 1.0.0
---

# Body

Do a thorough review.
`
    const parsed = parseSkillFrontmatter(raw)
    expect(parsed.name).toBe('code-review')
    expect(parsed.description).toBe('Review code carefully when asked for a structured review.')
    expect(parsed.metadata?.version).toBe('1.0.0')
    expect(parsed.body).toContain('thorough review')
  })

  it('folds multiline description block scalars', () => {
    const parsed = parseSkillFrontmatter(`---
name: create-skill
description: >-
  Create reusable skills.
  Use when authoring a new workflow.
metadata:
  version: "1.0.0"
---

Instructions.
`)
    expect(parsed.description).toBe(
      'Create reusable skills. Use when authoring a new workflow.'
    )
    expect(parsed.metadata?.version).toBe('1.0.0')
  })

  it('recovers Word-flattened SKILL.md that lost --- fences', () => {
    const parsed = parseSkillFrontmatter(
      'name: implement-feature description: Plan and implement a requested feature. Use when adding behavior. metadata: version: "1.0.0"\n\n## Instructions\n\nDo the work.\n'
    )
    expect(parsed.name).toBe('implement-feature')
    expect(parsed.description).toContain('Use when adding behavior')
    expect(parsed.metadata?.version).toBe('1.0.0')
    expect(parsed.body).toContain('## Instructions')
  })

  it('parses metadata.version and rejects invalid names', () => {
    const raw = `---
name: pdf-processing
description: Extract PDF text. Use when handling PDFs.
metadata:
  version: "2.0.0"
  author: example
---

Instructions.
`
    const parsed = parseSkillFrontmatter(raw)
    expect(parsed.metadata?.version).toBe('2.0.0')
    expect(parsed.metadata?.author).toBe('example')

    expect(() =>
      parseSkillFrontmatter(`---
name: Bad_Name
description: x
---

y
`)
    ).toThrow()
  })
})

describe('detectPackageAt', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-pkg-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('detects skill packages from SKILL.md and legacy skill.md', () => {
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: my-skill
description: A skill for testing install detection.
metadata:
  version: "1.2.0"
---

Instructions.
`
    )
    const detected = detectPackageAt(dir)
    expect(detected.kind).toBe('skill')
    expect(detected.id).toBe('my-skill')
    expect(detected.version).toBe('1.2.0')
  })

  it('detects skill packages whose SKILL.md was flattened by Word export', () => {
    writeFileSync(
      join(dir, 'SKILL.md'),
      'name: flattened-skill description: Use when installing a marketplace skill that lost YAML fences. metadata: version: "1.4.0"\n\nBody\n'
    )
    const detected = detectPackageAt(dir)
    expect(detected.kind).toBe('skill')
    expect(detected.id).toBe('flattened-skill')
    expect(detected.version).toBe('1.4.0')
  })

  it('detects legacy skill.md packages', () => {
    writeFileSync(
      join(dir, 'skill.md'),
      `---
name: legacy-skill
description: Legacy lowercase skill.md still installs.
version: 1.3.0
---

Instructions.
`
    )
    const detected = detectPackageAt(dir)
    expect(detected.kind).toBe('skill')
    expect(detected.id).toBe('legacy-skill')
    expect(detected.version).toBe('1.3.0')
  })

  it('detects mcp packages', () => {
    writeFileSync(
      join(dir, 'vyotiq.mcp.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'mcp',
        id: 'echo',
        name: 'Echo',
        version: '0.1.0',
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      })
    )
    const detected = detectPackageAt(dir)
    expect(detected.kind).toBe('mcp')
    expect(detected.id).toBe('echo')
  })

  it('detects plugin packages', () => {
    writeFileSync(
      join(dir, 'vyotiq.plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'plugin',
        id: 'devtools',
        name: 'Devtools',
        version: '1.0.0',
        mcp: [],
        skills: [],
        rules: []
      })
    )
    const detected = detectPackageAt(dir)
    expect(detected.kind).toBe('plugin')
  })
})

describe('buildSkillsSection', () => {
  it('lists metadata only and respects budget', () => {
    const skills: LoadedSkill[] = [
      {
        id: 'a',
        name: 'alpha',
        description: 'First skill description for discovery.',
        body: 'Do alpha things.',
        root: '/tmp/alpha',
        skillPath: '/tmp/alpha/SKILL.md',
        source: 'skill'
      },
      {
        id: 'b',
        name: 'beta',
        description: 'Second',
        body: 'x'.repeat(500),
        root: '/tmp/beta',
        skillPath: '/tmp/beta/SKILL.md',
        source: 'skill'
      }
    ]
    const section = buildSkillsSection(skills)
    expect(section).toContain('<available_skills>')
    expect(section).toContain('Skill')
    expect(section).toContain('alpha')
    expect(section).toContain('beta')
    expect(section).not.toContain('Do alpha things.')

    const tight = buildSkillsSection(skills, 80)
    expect(tight).toContain('<available_skills>')
    expect(tight).toMatch(/omitted/)
    expect(tight).not.toContain('Do alpha things.')
  })

  it('dedupes duplicate skill names preferring standalone', () => {
    const skills: LoadedSkill[] = [
      {
        id: 'plugin/code-review',
        name: 'code-review',
        description: 'Plugin copy',
        body: 'plugin body',
        root: '/tmp/p',
        skillPath: '/tmp/p/SKILL.md',
        source: 'plugin'
      },
      {
        id: 'code-review',
        name: 'code-review',
        description: 'Standalone copy',
        body: 'standalone body',
        root: '/tmp/s',
        skillPath: '/tmp/s/SKILL.md',
        source: 'skill'
      }
    ]
    const section = buildSkillsSection(skills)
    expect(section).toContain('Standalone copy')
    expect(section).not.toContain('Plugin copy')
    expect(section.match(/\*\*code-review\*\*/g)?.length).toBe(1)
  })
})

describe('describePackageAt', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-plugin-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('lists plugin nested skills and rules', async () => {
    mkdirSync(join(root, 'skills', 'review'), { recursive: true })
    mkdirSync(join(root, 'rules'), { recursive: true })
    writeFileSync(
      join(root, 'vyotiq.plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        kind: 'plugin',
        id: 'devtools',
        name: 'Devtools',
        version: '1.0.0',
        mcp: [],
        skills: ['skills/review'],
        rules: ['rules/conventions.md']
      })
    )
    writeFileSync(
      join(root, 'skills', 'review', 'SKILL.md'),
      `---
name: review
description: Review skill for plugin package contents tests.
---

Body
`
    )
    writeFileSync(join(root, 'rules', 'conventions.md'), '# Conventions\n')

    const { describePackageAt } = await import('@main/marketplace/packageContents')
    const contents = describePackageAt(root, { id: 'devtools', kind: 'plugin' })
    expect(contents.skills).toEqual([
      expect.objectContaining({ name: 'review', path: 'skills/review' })
    ])
    expect(contents.rules).toEqual([{ path: 'rules/conventions.md' }])
  })
})

describe('resolveEffectiveMcpServers', () => {
  it('applies marketplace mcp overrides to configured (manual) MCP servers', async () => {
    const settingsMod = await import('@main/settings/settings')
    const indexMod = await import('@main/marketplace/indexStore')
    const { resolveEffectiveMcpServers } = await import('@main/marketplace/resolve')
    const { DEFAULT_SETTINGS } = await import('@shared/ipc')

    vi.spyOn(settingsMod, 'getSettings').mockReturnValue({
      ...DEFAULT_SETTINGS,
      mcpServers: [
        {
          id: 'manual-fs',
          name: 'Manual',
          transport: 'stdio',
          command: 'echo',
          enabled: true,
          source: 'manual'
        }
      ]
    })
    vi.spyOn(indexMod, 'readMarketplaceIndex').mockReturnValue({
      schemaVersion: 1,
      items: []
    })

    const servers = resolveEffectiveMcpServers({ mcp: { 'manual-fs': false } })
    expect(servers.find((s) => s.id === 'manual-fs')?.enabled).toBe(false)
  })
})

describe('remote MCP install request', () => {
  it('accepts remote source with transport and bearer', async () => {
    const { MarketplaceInstallRequestSchema } = await import('@shared/ipc')
    const parsed = MarketplaceInstallRequestSchema.parse({
      source: 'remote',
      target: 'https://mcp.example.com/sse',
      kind: 'mcp',
      transport: 'sse',
      bearerToken: 'tok',
      name: 'Example'
    })
    expect(parsed.source).toBe('remote')
    expect(parsed.transport).toBe('sse')
    expect(parsed.bearerToken).toBe('tok')
  })
})

describe('bundled marketplace catalog', () => {
  it('has the workflow pack plus UI/API skills and on-disk manifests', async () => {
    const { MarketplaceCatalogSchema } = await import('@shared/ipc')
    const root = join(process.cwd(), 'resources', 'marketplace')
    const catalog = MarketplaceCatalogSchema.parse(
      JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'))
    )

    const skills = catalog.packages.filter((p) => p.kind === 'skill')
    const plugins = catalog.packages.filter((p) => p.kind === 'plugin')
    expect(skills.map((p) => p.id).sort()).toEqual([
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
    expect(plugins.map((p) => p.id).sort()).toEqual([
      'devtools',
      'electron-app',
      'quality',
      'shipping'
    ])

    const hostedUrls: Record<string, string> = {
      [GITHUB_MCP_ID]: 'https://api.githubcopilot.com/mcp/',
      [GMAIL_MCP_ID]: 'https://gmailmcp.googleapis.com/mcp/v1',
      [GOOGLE_DRIVE_MCP_ID]: 'https://drivemcp.googleapis.com/mcp/v1',
      [GOOGLE_CALENDAR_MCP_ID]: 'https://calendarmcp.googleapis.com/mcp/v1'
    }
    const hostedPublishers: Record<string, string> = {
      [GITHUB_MCP_ID]: 'GitHub',
      [GMAIL_MCP_ID]: 'Google',
      [GOOGLE_DRIVE_MCP_ID]: 'Google',
      [GOOGLE_CALENDAR_MCP_ID]: 'Google'
    }
    const infraRank = catalog.packages.find((p) => p.id === 'filesystem')?.featuredRank
    expect(infraRank).toEqual(expect.any(Number))
    for (const id of HOSTED_APP_MCP_IDS) {
      const entry = catalog.packages.find((p) => p.id === id)
      expect(entry, id).toBeTruthy()
      expect(entry!.kind).toBe('mcp')
      expect(entry!.installable).toBe(true)
      expect(entry!.verified).toBe(true)
      expect(entry!.publisher).toBe(hostedPublishers[id])
      expect(entry!.sections).toEqual(['discover', 'featured'])
      expect(entry!.featuredRank).toBeLessThan(infraRank!)
    }

    for (const entry of catalog.packages) {
      expect(entry.installable).not.toBe(false)
      expect(entry.bundledPath).toBeTruthy()
      const pkgRoot = join(root, 'packages', entry.bundledPath!)
      if (entry.kind === 'mcp') {
        const manifestPath = join(pkgRoot, 'vyotiq.mcp.json')
        expect(existsSync(manifestPath)).toBe(true)
        const manifest = VyotiqMcpManifestSchema.parse(
          JSON.parse(readFileSync(manifestPath, 'utf8'))
        )
        expect(manifest.id).toBe(entry.id)
        if (isHostedAppMcpId(entry.id)) {
          expect(manifest.transport).toBe('http')
          expect(manifest.url).toBe(hostedUrls[entry.id])
        }
      } else if (entry.kind === 'skill') {
        expect(
          existsSync(join(pkgRoot, 'SKILL.md')) || existsSync(join(pkgRoot, 'skill.md'))
        ).toBe(true)
      } else if (entry.kind === 'plugin') {
        expect(existsSync(join(pkgRoot, 'vyotiq.plugin.json'))).toBe(true)
      } else {
        const _exhaustive: never = entry.kind
        throw new Error(`unexpected kind ${_exhaustive}`)
      }
      if (entry.iconPath) {
        expect(existsSync(join(root, entry.iconPath))).toBe(true)
      }
    }
  })
})

describe('copyPackageIntoStore', () => {
  it('stages a replacement instead of deleting the destination first', () => {
    const src1 = mkdtempSync(join(tmpdir(), 'vyotiq-mkt-src1-'))
    const src2 = mkdtempSync(join(tmpdir(), 'vyotiq-mkt-src2-'))
    writeFileSync(join(src1, 'one.txt'), 'first', 'utf8')
    writeFileSync(join(src2, 'two.txt'), 'second', 'utf8')
    const id = `copy-pkg-${process.pid}`
    try {
      const dest = copyPackageIntoStore(src1, id, '1.0.0')
      expect(readFileSync(join(dest, 'one.txt'), 'utf8')).toBe('first')
      copyPackageIntoStore(src2, id, '1.0.0')
      expect(readFileSync(join(dest, 'two.txt'), 'utf8')).toBe('second')
      expect(existsSync(join(dest, 'one.txt'))).toBe(false)
    } finally {
      rmSync(src1, { recursive: true, force: true })
      rmSync(src2, { recursive: true, force: true })
      rmSync(join(tmpdir(), 'marketplace', 'packages', id), { recursive: true, force: true })
    }
  })
})
