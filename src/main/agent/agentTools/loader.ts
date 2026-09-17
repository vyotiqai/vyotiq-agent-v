/**
 * Pure text scanning of agent-built tool modules. Never imports or executes
 * tool code at scan time — the module header comment is the only input.
 */
import { readdir, readFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join } from 'path'
import type { AgentToolDef } from './types'
import { pathSafeName } from './paths'

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
        fingerprint: `${modulePath}:${info.mtimeMs}`
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
