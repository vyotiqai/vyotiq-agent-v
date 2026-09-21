/**
 * Pure text scanning of agent-built tool modules. Never imports or executes
 * tool code at scan time — the module header comment is the only input.
 */
import { createHash } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { AgentToolDef } from './types'
import { pathSafeName, resolveAgentToolsDir } from './paths'
import { BUILTIN_TOOL_NAMES } from '../schemas/tools'

const HEADER_MARKER = '/* @agent-tool'
const HEADER_RE = /\/\* @agent-tool\s+([\s\S]*?)\*\//

/** Parse the FIRST `/* @agent-tool {json} *\/` header from a .mjs source. */
function parseToolHeader(source: string): { name: string; description: string; inputSchema: unknown } | null {
  const match = source.match(HEADER_RE)
  if (!match || !match[1]) return null
  try {
    const header = JSON.parse(match[1]) as Record<string, unknown>
    return {
      name: typeof header.name === 'string' ? header.name : '',
      description: typeof header.description === 'string' ? header.description : '',
      inputSchema: header.inputSchema
    }
  } catch {
    return null
  }
}

/**
 * Scan every .mjs file in dir for a valid tool header. Duplicate names are
 * rejected by last-wins (later file replaces the earlier entry, no crash).
 * Result is sorted by name.
 */
export async function scanAgentTools(dir: string): Promise<AgentToolDef[]> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const byName = new Map<string, AgentToolDef>()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const modulePath = join(dir, entry.name)
    try {
      const [source, info] = await Promise.all([readFile(modulePath, 'utf8'), stat(modulePath)])
      const header = parseToolHeader(source)
      if (!header) continue
      const safe = pathSafeName(header.name)
      if (!safe || !header.description.trim()) continue
      if (!header.inputSchema || typeof header.inputSchema !== 'object' || Array.isArray(header.inputSchema)) {
        continue
      }
      byName.set(safe, {
        name: safe,
        description: header.description,
        inputSchema: header.inputSchema as Record<string, unknown>,
        modulePath,
        fingerprint: `${modulePath}:${info.mtimeMs}`,
        contentHash: createHash('sha256').update(source).digest('hex')
      })
    } catch {
      // Unreadable file — skip, never crash the scan.
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Stable fingerprint over path+mtimeMs so rescans only happen on real change. */
export function agentToolsFingerprint(defs: AgentToolDef[]): string {
  return defs
    .map((d) => d.fingerprint)
    .sort()
    .join('|')
}

type ToolsSnapshot = {
  dir: string
  /** Sorted `path:mtimeMs` listing of every .mjs in the dir (scan-independent). */
  dirFingerprint: string
  defs: AgentToolDef[]
}

let cachedSnapshot: ToolsSnapshot | null = null

/**
 * Cheap mtimes sweep over every .mjs file (valid header or not). `null` means
 * the directory could not be read this time — force a rescan then.
 */
async function dirListing(dir: string): Promise<string | null> {
  let entries: Dirent[] = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const parts: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    try {
      const info = await stat(join(dir, entry.name))
      parts.push(`${join(dir, entry.name)}:${info.mtimeMs}`)
    } catch {
      return null
    }
  }
  return parts.sort().join('|')
}

/**
 * Rescan only when the directory's .mjs mtimes changed since the last load;
 * return the cached defs otherwise. Writes to the dir appear without a
 * restart — the mtime sweep is cheap and runs on every call.
 */
export async function loadAgentToolsSnapshot(dir: string): Promise<AgentToolDef[]> {
  const listing = await dirListing(dir)
  if (
    cachedSnapshot &&
    cachedSnapshot.dir === dir &&
    listing !== null &&
    cachedSnapshot.dirFingerprint === listing
  ) {
    return cachedSnapshot.defs
  }
  const defs = await scanAgentTools(dir)
  cachedSnapshot = { dir, dirFingerprint: listing ?? '', defs }
  return defs
}

/**
 * Allowlist key for one agent-built tool, or null when the name is not one.
 *
 * `<name>@<hash>` rather than the bare name, because `build_tool` can rewrite
 * the module behind a stable name: an "always allow" keyed on the name alone
 * would silently carry over to code the user never saw. This is the same shape
 * as `acceptedOverrides` in settings/agentProfiles, which hashes an override
 * file's bytes so editing it withdraws consent.
 */
export async function agentBuiltToolAllowKey(dir: string, name: string): Promise<string | null> {
  const defs = await loadAgentToolsSnapshot(dir)
  const def = defs.find((d) => d.name === name)
  return def ? `${def.name}@${def.contentHash.slice(0, 16)}` : null
}

const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set<string>(BUILTIN_TOOL_NAMES)

/**
 * Agent-built tools as model-facing definitions.
 *
 * Returned every step rather than loaded on demand like MCP: the set is small,
 * it is this user's own code, and a tool written earlier in the run has to be
 * callable on the next step for `build_tool` to be worth anything. A failed
 * scan yields an empty catalog rather than failing the step.
 *
 * It lives here rather than beside the dispatcher in `tools/index.ts` because
 * the run loop needs it: importing that barrel from `loop.ts` closes the cycle
 * loop → tools → instanceTools → agentInstances → loop, which leaves
 * `AGENT_TOOLS` empty at module-init time and strips every builtin off the wire.
 */
export async function agentBuiltToolDefinitions(): Promise<
  { name: string; description: string; parameters: Record<string, unknown> }[]
> {
  try {
    const defs = await loadAgentToolsSnapshot(await resolveAgentToolsDir())
    return defs
      .filter((def) => !RESERVED_TOOL_NAMES.has(def.name) && !def.name.startsWith('mcp__'))
      .map((def) => ({
        name: def.name,
        description: def.description,
        parameters: def.inputSchema
      }))
  } catch {
    return []
  }
}
