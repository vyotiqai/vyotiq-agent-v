import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { VyotiqMcpManifestSchema, type DetectedMcpServer } from '../../shared/ipc'
import { loadBundledCatalog } from './catalog'
import { bundledPackagePath } from './paths'

/** Launchers that fetch and run a named package: the package is the server. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx'])
/** Flags whose value is the package itself (`npx -p pkg cmd`, `uvx --from pkg cmd`). */
const PACKAGE_FLAGS = new Set(['-p', '--package', '--from'])
/** Flags whose value is something else (`uvx --with mcp<2 …`, `uvx --python 3.12 …`). */
const VALUE_FLAGS = new Set(['--with', '--python', '--index-url', '--extra-index-url'])

function launcherName(command: string): string {
  // `npx.cmd`, `C:\…\uvx.exe` and `NPX` all launch the same thing.
  const base = command.trim().split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '')
}

/** A package spec without its version: `@playwright/mcp@latest` → `@playwright/mcp`, `pkg==1.2` → `pkg`. */
function stripVersion(token: string | undefined): string | undefined {
  if (!token) return undefined
  const spec = token.trim().toLowerCase().split(/[=<>~!]/)[0] ?? ''
  // npm keeps a scope's leading `@`; only a later one starts the version.
  const at = spec.lastIndexOf('@')
  return (at > 0 ? spec.slice(0, at) : spec) || undefined
}

/** The package a package-runner line runs, skipping its flags. */
export function primaryPackage(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!.trim()
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('-') && eq > 0 ? arg.slice(0, eq) : arg
    if (PACKAGE_FLAGS.has(flag)) return stripVersion(eq > 0 && flag !== arg ? arg.slice(eq + 1) : args[i + 1])
    if (VALUE_FLAGS.has(flag)) {
      if (flag === arg) i++
      continue
    }
    if (arg.startsWith('-')) continue
    return stripVersion(arg)
  }
  return undefined
}

/** The package a runner line (`npx -y pkg@1`, `uvx --from pkg cmd`) runs; undefined for any other command. */
export function runnerPackage(command: string, args: readonly string[]): string | undefined {
  return PACKAGE_RUNNERS.has(launcherName(command)) ? primaryPackage(args) : undefined
}

/**
 * What makes two launch configs the same server. A remote server is its
 * endpoint (scheme, host, path — not the query, which may carry a key); a
 * package runner is the package it runs, whatever the version pin or extra
 * options; anything else has to match exactly.
 */
export function mcpLaunchIdentity(
  server: Pick<DetectedMcpServer, 'transport' | 'command' | 'args' | 'url'>
): string | undefined {
  if (server.transport === 'http' || server.transport === 'sse') {
    try {
      const u = new URL((server.url ?? '').trim())
      return `url:${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`
    } catch {
      return undefined
    }
  }
  const command = (server.command ?? '').trim()
  if (!command) return undefined
  const launcher = launcherName(command)
  const args = server.args ?? []
  if (PACKAGE_RUNNERS.has(launcher)) {
    const pkg = primaryPackage(args)
    return pkg ? `pkg:${launcher}:${pkg}` : undefined
  }
  return `exact:${launcher}\0${args.map((a) => a.trim()).join('\0')}`
}

/**
 * The bundled catalog package that launches the same server, if any. Remote
 * registry entries carry no launch config until they are downloaded, so only
 * bundled packages can be compared.
 */
export function findCatalogMcpMatch(
  server: Pick<DetectedMcpServer, 'transport' | 'command' | 'args' | 'url'>
): { id: string; name: string } | undefined {
  const identity = mcpLaunchIdentity(server)
  if (!identity) return undefined
  for (const entry of loadBundledCatalog().packages) {
    if (entry.kind !== 'mcp' || !entry.bundledPath) continue
    try {
      const manifestPath = join(bundledPackagePath(entry.bundledPath), 'vyotiq.mcp.json')
      if (!existsSync(manifestPath)) continue
      const manifest = VyotiqMcpManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
      if (mcpLaunchIdentity(manifest) === identity) return { id: entry.id, name: entry.name }
    } catch {
      // A package that cannot be read is not a match.
    }
  }
  return undefined
}
