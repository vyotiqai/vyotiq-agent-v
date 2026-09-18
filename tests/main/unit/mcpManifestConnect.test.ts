import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { MarketplaceCatalogSchema, VyotiqMcpManifestSchema } from '@shared/ipc'
import { isBlockedMcpEnvKey } from '@main/marketplace/sanitizeMcpEnv'

const PACKAGES_ROOT = join(process.cwd(), 'resources/marketplace/packages')

function bundledMcpManifestPaths(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PACKAGES_ROOT, e.name, 'vyotiq.mcp.json'))
    .filter((p) => {
      try {
        readFileSync(p)
        return true
      } catch {
        return false
      }
    })
}

const base = {
  schemaVersion: 1 as const,
  kind: 'mcp' as const,
  id: 'demo',
  name: 'Demo',
  version: '1.0.0'
}

describe('VyotiqMcpManifestSchema connect metadata', () => {
  it('defaults auth to none so legacy manifests keep parsing', () => {
    const parsed = VyotiqMcpManifestSchema.parse({
      ...base,
      transport: 'stdio',
      command: 'npx'
    })
    expect(parsed.auth).toBe('none')
    expect(parsed.requires).toBeUndefined()
    expect(parsed.inputs).toBeUndefined()
  })

  it('accepts oauth on http transport', () => {
    const parsed = VyotiqMcpManifestSchema.parse({
      ...base,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth'
    })
    expect(parsed.auth).toBe('oauth')
  })

  it('rejects oauth on stdio, which startMcpOAuth cannot service', () => {
    const res = VyotiqMcpManifestSchema.safeParse({
      ...base,
      transport: 'stdio',
      command: 'npx',
      auth: 'oauth'
    })
    expect(res.success).toBe(false)
    expect(JSON.stringify(res.error?.issues)).toContain('requires http or sse transport')
  })

  it('rejects token auth with no declared inputs', () => {
    const res = VyotiqMcpManifestSchema.safeParse({
      ...base,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'token'
    })
    expect(res.success).toBe(false)
    expect(JSON.stringify(res.error?.issues)).toContain('at least one entry in inputs')
  })

  it('applies input defaults and rejects duplicates on the same target', () => {
    const parsed = VyotiqMcpManifestSchema.parse({
      ...base,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'token',
      inputs: [{ name: 'API_KEY' }]
    })
    expect(parsed.inputs?.[0]).toMatchObject({
      name: 'API_KEY',
      target: 'env',
      isSecret: false,
      isRequired: true
    })

    const dup = VyotiqMcpManifestSchema.safeParse({
      ...base,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'token',
      inputs: [
        { name: 'API_KEY', target: 'header' },
        { name: 'api_key', target: 'header' }
      ]
    })
    expect(dup.success).toBe(false)
    expect(JSON.stringify(dup.error?.issues)).toContain('duplicate input')
  })

  it('treats the same name on different targets as distinct', () => {
    const parsed = VyotiqMcpManifestSchema.parse({
      ...base,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'token',
      inputs: [
        { name: 'TOKEN', target: 'env' },
        { name: 'TOKEN', target: 'header' }
      ]
    })
    expect(parsed.inputs).toHaveLength(2)
  })

  it('rejects a non-url setupUrl', () => {
    const res = VyotiqMcpManifestSchema.safeParse({
      ...base,
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      setupUrl: 'not a url'
    })
    expect(res.success).toBe(false)
  })
})

describe('bundled MCP manifests', () => {
  const paths = bundledMcpManifestPaths()

  it('finds the shipped manifests', () => {
    expect(paths.length).toBeGreaterThanOrEqual(10)
  })

  it.each(paths)('%s parses and declares its connect metadata', (path) => {
    const parsed = VyotiqMcpManifestSchema.parse(
      JSON.parse(readFileSync(path, 'utf8')) as unknown
    )

    // Every stdio package must declare the binaries it shells out to, or the
    // preflight in createTransport has nothing to check and users get ENOENT.
    if (parsed.transport === 'stdio') {
      expect(parsed.requires ?? []).not.toHaveLength(0)
      const command = (parsed.command ?? '').toLowerCase()
      if (command === 'npx') expect(parsed.requires).toContain('node')
      if (command === 'uvx') expect(parsed.requires).toContain('uv')
    }

    // A remote package that needs credentials must say how, otherwise the UI
    // falls back to the raw config editor this work exists to remove.
    if (parsed.transport !== 'stdio') {
      expect(['none', 'oauth', 'oauth-client', 'token']).toContain(parsed.auth)
    }

    // `buildMcpChildEnv` drops these keys at spawn time, so an input naming one
    // would render a field whose value is silently discarded.
    for (const input of parsed.inputs ?? []) {
      if (input.target === 'env') expect(isBlockedMcpEnvKey(input.name)).toBe(false)
    }
  })
})

describe('bundled catalog', () => {
  const catalog = MarketplaceCatalogSchema.parse(
    JSON.parse(
      readFileSync(join(process.cwd(), 'resources/marketplace/catalog.json'), 'utf8')
    ) as unknown
  )
  const mcpEntries = catalog.packages.filter((p) => p.kind === 'mcp')

  it('ships the connectable servers this work added', () => {
    const ids = new Set(mcpEntries.map((e) => e.id))
    for (const id of ['context7', 'linear', 'notion', 'sentry', 'slack', 'playwright']) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it.each(mcpEntries.map((e) => [e.id, e] as const))(
    '%s mirrors its manifest auth and requires',
    (id, entry) => {
      // The catalog copy is what Browse reads before anything is installed;
      // drift would silently show the wrong Connect affordance.
      const manifest = VyotiqMcpManifestSchema.parse(
        JSON.parse(
          readFileSync(
            join(PACKAGES_ROOT, entry.bundledPath ?? id, 'vyotiq.mcp.json'),
            'utf8'
          )
        ) as unknown
      )
      expect(entry.auth).toBe(manifest.auth)
      expect(entry.requires ?? []).toEqual(manifest.requires ?? [])
      expect(entry.name).toBe(manifest.name)
    }
  )

  it('keeps package ids unique', () => {
    const ids = catalog.packages.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
