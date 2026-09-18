import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata
} from '@modelcontextprotocol/sdk/client/auth.js'
import { isGoogleMcpId } from '@shared/mcpApps'

const PACKAGES = join(process.cwd(), 'resources/marketplace/packages')

type Manifest = { id: string; url?: string; auth?: string; setupUrl?: string }

const remote: Manifest[] = readdirSync(PACKAGES)
  .map((dir) => join(PACKAGES, dir, 'vyotiq.mcp.json'))
  .flatMap((file) => {
    try {
      return [JSON.parse(readFileSync(file, 'utf8')) as Manifest]
    } catch {
      return []
    }
  })
  .filter((m) => m.url && m.auth && m.auth !== 'none')
  .sort((a, b) => a.id.localeCompare(b.id))

/**
 * Only this file needs the network, so an offline run must not look like a code
 * defect. Probe once and skip with a visible reason instead.
 */
const online = await fetch('https://github.com/.well-known/oauth-authorization-server/login/oauth', {
  signal: AbortSignal.timeout(8_000)
})
  .then((r) => r.ok)
  .catch(() => false)

/** Follow the same discovery chain the SDK runs at connect time. */
async function supportsDcr(url: string): Promise<boolean | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'vyotiq-authkind-test', version: '1' }
      }
    }),
    signal: AbortSignal.timeout(20_000)
  })

  const resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(
    res.headers.get('www-authenticate') ?? ''
  )?.[1]

  let servers: string[] = []
  if (resourceMetadataUrl) {
    const prm = await discoverOAuthProtectedResourceMetadata(url, { resourceMetadataUrl })
    servers = prm?.authorization_servers ?? []
  }
  if (!servers.length) servers = [new URL(url).origin]

  const meta = await discoverAuthorizationServerMetadata(servers[0])
  return meta ? Boolean(meta.registration_endpoint) : null
}

describe('bundled MCP auth kinds match the live authorization servers', () => {
  it('found remote packages to check', () => {
    expect(remote.length).toBeGreaterThan(0)
  })

  for (const manifest of remote) {
    it.skipIf(!online)(
      `${manifest.id} declares the auth kind its server actually supports`,
      async () => {
        const dcr = await supportsDcr(manifest.url!)

        if (isGoogleMcpId(manifest.id)) {
          // Google's MCP endpoints publish no authorization-server metadata at
          // all; they are driven by the client bundled with the app, so the
          // user is never asked to register one. `oauth` is correct for them.
          expect(dcr, `${manifest.id} unexpectedly grew discoverable metadata`).toBeNull()
          expect(manifest.auth).toBe('oauth')
          return
        }

        // Everything else: a registration_endpoint is exactly what lets the
        // SDK self-register, which is what `oauth` promises the user. Without
        // one the SDK throws "does not support dynamic client registration",
        // so the entry must collect a client instead.
        expect(dcr, `${manifest.id} has no discoverable authorization server`).not.toBeNull()
        expect(manifest.auth, `${manifest.id} advertises DCR=${dcr}`).toBe(
          dcr ? 'oauth' : 'oauth-client'
        )

        // An `oauth-client` entry is unusable without somewhere to register.
        if (manifest.auth === 'oauth-client') {
          expect(manifest.setupUrl, `${manifest.id} needs a setupUrl`).toMatch(/^https:\/\//)
        }
      },
      45_000
    )
  }
})
