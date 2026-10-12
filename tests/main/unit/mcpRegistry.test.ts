import { describe, expect, it, vi } from 'vitest'
import { parseRegistryResponse, parseRegistryServer, searchMcpRegistry } from '@main/marketplace/mcpRegistry'

/** The official MCP Registry's answers, in its current and its first shape. */
describe('MCP Registry results', () => {
  it('reads the current shape: a remote first, else a package, with its environment', () => {
    expect(
      parseRegistryServer({
        server: {
          name: 'io.github.acme/db',
          title: 'Acme DB',
          description: 'Query Acme',
          version: '2.0.0',
          repository: { url: 'https://github.com/acme/db', source: 'github' },
          packages: [
            {
              registryType: 'npm',
              identifier: '@acme/db-mcp',
              transport: { type: 'stdio' },
              environmentVariables: [
                { name: 'ACME_URL', isRequired: true, isSecret: true, description: 'Where' },
                { name: 'bad name', isRequired: true }
              ]
            }
          ]
        },
        _meta: {}
      })
    ).toEqual({
      name: 'io.github.acme/db',
      title: 'Acme DB',
      description: 'Query Acme',
      version: '2.0.0',
      repository: 'https://github.com/acme/db',
      launch: 'npx -y @acme/db-mcp',
      remote: false,
      env: [{ name: 'ACME_URL', description: 'Where', required: true, secret: true }]
    })
    expect(
      parseRegistryServer({
        name: 'remote/one',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
        packages: [{ registryType: 'pypi', identifier: 'one-mcp' }]
      })
    ).toMatchObject({ launch: 'https://mcp.example.com/mcp', remote: true, env: [] })
  })

  it('reads the first shape, and launches pypi and docker packages', () => {
    expect(parseRegistryServer({ name: 'a', packages: [{ registry_name: 'pypi', name: 'mcp-a' }] })?.launch).toBe('uvx mcp-a')
    expect(parseRegistryServer({ name: 'b', packages: [{ registry_name: 'docker', name: 'acme/b' }] })?.launch).toBe(
      'docker run -i --rm acme/b'
    )
    expect(
      parseRegistryServer({ name: 'c', packages: [{ registry_name: 'npm', name: 'c', environment_variables: [{ name: 'C_KEY', is_required: true }] }] })
        ?.env
    ).toEqual([{ name: 'C_KEY', description: '', required: true, secret: false }])
  })

  it('leaves out what it cannot launch: no name, an http remote, an unknown registry', () => {
    expect(parseRegistryServer({ packages: [{ registryType: 'npm', identifier: 'x' }] })).toBeNull()
    expect(parseRegistryServer({ name: 'x', remotes: [{ type: 'sse', url: 'http://plain' }] })).toBeNull()
    expect(parseRegistryServer({ name: 'x', packages: [{ registryType: 'nuget', identifier: 'X' }] })).toBeNull()
  })

  it('keeps one entry per name, the last listed', () => {
    const list = parseRegistryResponse({
      servers: [
        { name: 'dup', version: '1', packages: [{ registryType: 'npm', identifier: 'dup' }] },
        { name: 'dup', version: '2', packages: [{ registryType: 'npm', identifier: 'dup' }] }
      ],
      metadata: { count: 2 }
    })
    expect(list.map((s) => s.version)).toEqual(['2'])
  })

  it('asks with the query, a limit and the latest version only, and reports a refusal', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      void url
      return new Response(JSON.stringify({ servers: [] }), { status: 200 })
    })
    await searchMcpRegistry(' postgres ', fetchImpl as unknown as typeof fetch)
    const asked = new URL(fetchImpl.mock.calls[0]![0])
    expect(asked.searchParams.get('search')).toBe('postgres')
    expect(asked.searchParams.get('version')).toBe('latest')
    const failing = vi.fn(async () => new Response('', { status: 503 }))
    await expect(searchMcpRegistry('x', failing as unknown as typeof fetch)).rejects.toThrow(/503/)
  })
})
