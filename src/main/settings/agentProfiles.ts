import { app } from 'electron'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import {
  AgentProfileIdSchema,
  AgentProfileOverrideSchema,
  AgentProfileSchema,
  IPC,
  type AgentProfile,
  type AgentProfileCreateRequest,
  type AgentProfileDeleteRequest,
  type AgentProfileOverride,
  type AgentProfileUpdateRequest
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { assertSafeMemoryNamespace } from '../agent/context/memory'
import { assertResolvedInsideWorkspace } from '../workspace/safePath'
import { atomicWriteJson } from '../storage/atomicWrite'
import { getMainWindow } from '../app/window'
import { enqueueSettingsMutation } from './settings'

/**
 * Global teammate roster. Profiles are the identity primitive referenced by
 * runs; the roster is one small JSON file next to settings.json. A workspace
 * may override individual fields of a global profile via
 * `.vyotiq/agents/<profileId>.profile.json` (per-field merge, git-shareable).
 */

const PROFILES_VERSION = 2

class UnsupportedAgentProfilesVersionError extends Error {}

type AgentProfilesFile = {
  version: number
  profiles: AgentProfile[]
  /**
   * Ids of deleted teammates. Ids are slugified from the name and become the
   * memory-namespace path segment, so reusing a freed slug would hand a newly
   * created teammate the dead identity's private notes and its historical
   * runs' binding. Deleting a teammate preserves that data (run history and
   * memory are never erased on delete), so the id is retired instead.
   */
  retiredIds: string[]
}

let profilesCache: AgentProfilesFile | null = null

function profilesPath(): string {
  return join(app.getPath('userData'), 'agents.json')
}

function emptyFile(): AgentProfilesFile {
  return { version: PROFILES_VERSION, profiles: [], retiredIds: [] }
}

function parseProfileArray(raw: unknown, version: number): AgentProfile[] {
  const parsed = raw as Partial<AgentProfilesFile> | null
  if (!parsed || !Array.isArray(parsed.profiles)) {
    throw new Error(`Invalid agents.json version ${version} document`)
  }
  const profiles: AgentProfile[] = []
  for (const candidate of parsed.profiles) {
    const result = AgentProfileSchema.safeParse(candidate)
    if (result.success) profiles.push(result.data)
    else {
      logger.warn('Dropping invalid agent profile from roster', {
        scope: 'agentProfiles',
        id: (candidate as { id?: unknown })?.id
      })
    }
  }
  return profiles
}

/** v1 had no retired-id ledger: every id a v1 install freed was already reused. */
function parseVersion1ProfilesFile(raw: unknown): AgentProfilesFile {
  return { version: PROFILES_VERSION, profiles: parseProfileArray(raw, 1), retiredIds: [] }
}

function parseVersion2ProfilesFile(raw: unknown): AgentProfilesFile {
  const retired = (raw as { retiredIds?: unknown } | null)?.retiredIds
  const retiredIds = Array.isArray(retired)
    ? [...new Set(retired.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  return { version: PROFILES_VERSION, profiles: parseProfileArray(raw, 2), retiredIds }
}

function parseProfilesFile(raw: unknown): AgentProfilesFile {
  const version = (raw as { version?: unknown } | null)?.version
  if (version === 1) return parseVersion1ProfilesFile(raw)
  if (version === 2) return parseVersion2ProfilesFile(raw)
  if (typeof version === 'number' && version > PROFILES_VERSION) {
    throw new UnsupportedAgentProfilesVersionError(`Unsupported agents.json version: ${version}`)
  }
  throw new Error(`Unsupported agents.json version: ${String(version)}`)
}

function loadProfiles(): AgentProfilesFile {
  if (profilesCache) return profilesCache
  const path = profilesPath()
  if (!existsSync(path)) {
    profilesCache = emptyFile()
    return profilesCache
  }
  try {
    profilesCache = parseProfilesFile(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    if (err instanceof UnsupportedAgentProfilesVersionError) throw err
    // Preserve the unreadable roster before treating it as empty — the next
    // mutation would otherwise overwrite the file and permanently discard
    // every profile with no recoverable trace.
    const backup = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, backup)
      logger.warn('Corrupt agents.json moved aside', { scope: 'agentProfiles', backup, err })
    } catch (renameErr) {
      logger.warn('Failed to read agents.json — starting empty roster', {
        scope: 'agentProfiles',
        err,
        renameErr
      })
    }
    profilesCache = emptyFile()
  }
  return profilesCache
}

/** @internal — clear the in-process roster cache (tests). */
export function clearAgentProfilesCacheForTests(): void {
  profilesCache = null
}

function writeProfiles(next: AgentProfilesFile): void {
  atomicWriteJson(profilesPath(), next, 0o600)
  profilesCache = next
}

export function listAgentProfiles(): AgentProfile[] {
  return [...loadProfiles().profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function getAgentProfile(id: string): AgentProfile | null {
  return loadProfiles().profiles.find((p) => p.id === id) ?? null
}

function slugifyName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length > 0 ? slug : 'teammate'
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

export function createAgentProfile(request: AgentProfileCreateRequest): AgentProfile {
  const file = loadProfiles()
  // Retired ids count as taken: a deleted teammate keeps its memory namespace
  // and its historical runs' binding, so handing its slug to a new teammate
  // would silently adopt both.
  const taken = new Set([...file.profiles.map((p) => p.id), ...file.retiredIds])
  const now = new Date().toISOString()
  const profile: AgentProfile = {
    ...request,
    scope: request.scope ?? 'global',
    id: uniqueId(slugifyName(request.name), taken),
    createdAt: now,
    updatedAt: now
  }
  const parsed = AgentProfileSchema.parse(profile)
  writeProfiles({ ...file, version: PROFILES_VERSION, profiles: [...file.profiles, parsed] })
  return parsed
}

export function updateAgentProfile(request: AgentProfileUpdateRequest): AgentProfile {
  const file = loadProfiles()
  const index = file.profiles.findIndex((p) => p.id === request.id)
  if (index === -1) throw new Error(`Unknown agent profile: ${request.id}`)
  const merged: AgentProfile = {
    ...file.profiles[index]!,
    ...request.patch,
    id: request.id,
    createdAt: file.profiles[index]!.createdAt,
    updatedAt: new Date().toISOString()
  }
  const parsed = AgentProfileSchema.parse(merged)
  const profiles = [...file.profiles]
  profiles[index] = parsed
  writeProfiles({ ...file, version: PROFILES_VERSION, profiles })
  return parsed
}

export function deleteAgentProfile(request: AgentProfileDeleteRequest): true {
  const file = loadProfiles()
  const profiles = file.profiles.filter((p) => p.id !== request.id)
  if (profiles.length === file.profiles.length) {
    throw new Error(`Unknown agent profile: ${request.id}`)
  }
  writeProfiles({
    version: PROFILES_VERSION,
    profiles,
    retiredIds: [...new Set([...file.retiredIds, request.id])]
  })
  return true
}

/** @internal — ids retired by past deletions (tests/diagnostics). */
export function listRetiredAgentProfileIds(): string[] {
  return [...loadProfiles().retiredIds]
}

export type RemoveProfileArtifactsOptions = {
  /**
   * Also delete the profile's private memory namespace. Off by default:
   * deleting a teammate ends its work, it does not erase the notes it wrote or
   * the history of what it did. Ids are retired rather than reused, so a new
   * teammate can never inherit a surviving namespace.
   */
  purgeMemory?: boolean
}

export type RemoveProfileArtifactsResult = {
  removed: string[]
  /** Paths that could not be removed, with the reason — never swallowed. */
  failures: { path: string; error: string }[]
}

/**
 * Remove the per-workspace override files a deleted profile owns. The override
 * is the dead identity's *behavior*, which must not survive to re-skin a future
 * teammate; its memory namespace and run history are preserved unless the
 * caller explicitly asks to purge them.
 */
export function removeProfileArtifactsForWorkspaces(
  profileId: string,
  workspacePaths: readonly string[],
  options: RemoveProfileArtifactsOptions = {}
): RemoveProfileArtifactsResult {
  const result: RemoveProfileArtifactsResult = { removed: [], failures: [] }
  // The id becomes a path segment. It is already constrained by
  // AgentProfileIdSchema, but a recursive delete must never trust that from a
  // distance — re-check with the same guard the memory write path uses.
  try {
    assertSafeMemoryNamespace(profileId)
  } catch {
    logger.warn('Refusing to remove artifacts for an unsafe profile id', {
      scope: 'agentProfiles',
      profileId
    })
    result.failures.push({ path: profileId, error: 'Unsafe profile id' })
    return result
  }
  for (const workspacePath of workspacePaths) {
    const paths = [workspaceOverridePath(workspacePath, profileId)]
    if (options.purgeMemory) paths.push(workspaceProfileDir(workspacePath, profileId))
    for (const path of paths) {
      try {
        if (!existsSync(path)) continue
        rmSync(path, { force: true, recursive: true })
        result.removed.push(path)
      } catch (err) {
        logger.warn('Failed to remove workspace profile artifact', {
          scope: 'agentProfiles',
          path,
          err
        })
        result.failures.push({ path, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return result
}

const OVERRIDE_SUFFIX = '.profile.json'

function workspaceOverridePath(workspacePath: string, profileId: string): string {
  return join(workspacePath, '.vyotiq', 'agents', `${profileId}${OVERRIDE_SUFFIX}`)
}

/** The profile's own directory — holds its memory namespace and nothing else. */
function workspaceProfileDir(workspacePath: string, profileId: string): string {
  return join(workspacePath, '.vyotiq', 'agents', profileId)
}

/**
 * Per-workspace field overrides for a global profile, stored git-shareable at
 * `.vyotiq/agents/<profileId>.profile.json`. Only identity/behavior fields may
 * be overridden — id, timestamps, scope, and workspacePath stay global-owned.
 */
export function readWorkspaceProfileOverride(
  workspacePath: string | null | undefined,
  profileId: string
): AgentProfileOverride | null {
  if (!workspacePath) return null
  const path = workspaceOverridePath(workspacePath, profileId)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    // Identity/ownership fields are global-owned: a workspace file can never
    // rename a teammate, change its id/timestamps, or move its scope.
    delete raw.id
    delete raw.name
    delete raw.createdAt
    delete raw.updatedAt
    delete raw.scope
    delete raw.workspacePath
    const patch = AgentProfileOverrideSchema.parse(raw)
    return Object.keys(patch).length > 0 ? patch : null
  } catch (err) {
    logger.warn('Ignoring invalid workspace profile override', {
      scope: 'agentProfiles',
      path,
      err
    })
    return null
  }
}

/**
 * Every override stored in one workspace, keyed by profile id.
 *
 * Reads the directory rather than the roster so an override left behind by a
 * teammate that no longer exists is still visible — otherwise a stale file
 * would keep applying to a re-created id with nothing in the UI to show it.
 */
export function listWorkspaceProfileOverrides(
  workspacePath: string
): Record<string, AgentProfileOverride> {
  let entries: string[]
  try {
    entries = readdirSync(join(workspacePath, '.vyotiq', 'agents'))
  } catch {
    // No directory means no overrides. That is the ordinary case, not a fault.
    return {}
  }
  const out: Record<string, AgentProfileOverride> = {}
  for (const entry of entries) {
    if (!entry.endsWith(OVERRIDE_SUFFIX)) continue
    const profileId = entry.slice(0, -OVERRIDE_SUFFIX.length)
    // The filename is the id, and files arrive by hand and over git. Validate
    // before it becomes a key the renderer will index by.
    if (!AgentProfileIdSchema.safeParse(profileId).success) continue
    const override = readWorkspaceProfileOverride(workspacePath, profileId)
    if (override) out[profileId] = override
  }
  return out
}

/**
 * Write or clear one workspace's override of a profile.
 *
 * Replaces rather than merges. `setWorkspaceSettingsOverride` merges because
 * several surfaces write it from independent React snapshots; this has one
 * writer holding the whole override, and merging would leave no way to clear a
 * single field.
 */
export function writeWorkspaceProfileOverride(
  workspacePath: string,
  profileId: string,
  override: AgentProfileOverride | null
): AgentProfileOverride | null {
  // The id becomes a path segment. It was validated at the IPC boundary, but
  // a write must not trust that from a distance — same guard as the delete path.
  assertSafeMemoryNamespace(profileId)
  const path = workspaceOverridePath(workspacePath, profileId)
  // Checked BEFORE the write, not after. `atomicWriteJson` creates missing
  // directories, so a junctioned `.vyotiq` would otherwise have a file written
  // outside the workspace before anything noticed it had escaped.
  assertResolvedInsideWorkspace(workspacePath, path)
  const next = override ? AgentProfileOverrideSchema.parse(override) : null
  if (!next || Object.keys(next).length === 0) {
    // Clearing never touches `<ws>/.vyotiq/agents/<id>/`, the teammate's
    // memory namespace. Resetting behaviour must not erase the notes it wrote.
    rmSync(path, { force: true })
    return null
  }
  // Default mode, not the roster's 0o600: this file is documented as
  // git-shareable, so it is meant to be readable and committed.
  atomicWriteJson(path, next)
  return next
}

/** Global profile with workspace overrides applied; null when the id is unknown. */
export function resolveAgentProfile(
  workspacePath: string | null | undefined,
  profileId: string
): AgentProfile | null {
  const base = getAgentProfile(profileId)
  if (!base) return null
  if (
    base.scope === 'workspace' &&
    (!workspacePath || !base.workspacePath || !workspacePathsEqual(workspacePath, base.workspacePath))
  ) {
    return null
  }
  const override = readWorkspaceProfileOverride(workspacePath, profileId)
  if (!override) return base
  return AgentProfileSchema.parse({
    ...base,
    ...override,
    id: base.id,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt
  })
}

/**
 * Serialized mutations so concurrent IPC handlers cannot interleave
 * load→modify→write cycles on the roster.
 */
export function mutateAgentProfiles<T>(fn: () => T | Promise<T>): Promise<T> {
  return enqueueSettingsMutation(fn)
}

/** Broadcast the full roster after any mutation (renderer replaces its list). */
export function emitAgentProfilesChanged(): void {
  try {
    const main = getMainWindow()
    if (!main || main.isDestroyed()) return
    main.webContents.send(IPC.agentProfilesChanged, { profiles: listAgentProfiles() })
  } catch (err) {
    logger.warn('Failed to emit agent profiles change', { scope: 'agentProfiles', err })
  }
}

/**
 * Broadcast one workspace overrides map after a change.
 *
 * Separate from the roster push, which carries global profiles and no
 * workspace key — it could not say whose overrides moved. Note this fires on
 * app writes only: a file edited on disk by hand is picked up the next time
 * the workspace is read, not pushed.
 */
export function emitAgentProfileOverridesChanged(workspacePath: string): void {
  try {
    const main = getMainWindow()
    if (!main || main.isDestroyed()) return
    main.webContents.send(IPC.agentProfileOverridesChanged, {
      workspacePath,
      overrides: listWorkspaceProfileOverrides(workspacePath)
    })
  } catch (err) {
    logger.warn('Failed to emit agent profile overrides change', { scope: 'agentProfiles', err })
  }
}
