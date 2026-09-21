import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import {
  AgentProfileIdSchema,
  AgentProfileOverrideSchema,
  AgentProfileSchema,
  PRIVILEGED_OVERRIDE_FIELDS,
  IPC,
  type AgentProfile,
  type AgentProfileCreateRequest,
  type AgentProfileDeleteRequest,
  type AgentProfileOverride,
  type AgentProfileUpdateRequest
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { canonicalizeWorkspacePath, isWindowsStylePath } from '../../shared/utils/workspacePath'
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
  /**
   * Override files the user has accepted, `<workspace>\0<profileId>` → SHA-256
   * of the file's bytes.
   *
   * Hashing the bytes is what makes acceptance mean "this file, as I read it":
   * editing it — or pulling a change to it — withdraws consent automatically.
   * Absent from a file written by an older build, which reads as "nothing
   * accepted yet" and is already the correct fail-safe default.
   */
  acceptedOverrides: Record<string, string>
}

let profilesCache: AgentProfilesFile | null = null

function profilesPath(): string {
  return join(app.getPath('userData'), 'agents.json')
}

function emptyFile(): AgentProfilesFile {
  return { version: PROFILES_VERSION, profiles: [], retiredIds: [], acceptedOverrides: {} }
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
  return {
    version: PROFILES_VERSION,
    profiles: parseProfileArray(raw, 1),
    retiredIds: [],
    acceptedOverrides: {}
  }
}

/**
 * `acceptedOverrides` is read leniently rather than behind a version bump.
 *
 * A v2 file without the key reads as `{}`, which is already the correct
 * fail-safe default — there is no migration semantics to express. The v1→v2
 * bump existed because a v1 install had *already* reused freed ids, so the
 * reader had to know that; nothing equivalent is true here.
 */
function parseVersion2ProfilesFile(raw: unknown): AgentProfilesFile {
  const retired = (raw as { retiredIds?: unknown } | null)?.retiredIds
  const retiredIds = Array.isArray(retired)
    ? [...new Set(retired.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const accepted = (raw as { acceptedOverrides?: unknown } | null)?.acceptedOverrides
  const acceptedOverrides: Record<string, string> = {}
  if (accepted && typeof accepted === 'object' && !Array.isArray(accepted)) {
    for (const [key, value] of Object.entries(accepted as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) acceptedOverrides[key] = value
    }
  }
  return {
    version: PROFILES_VERSION,
    profiles: parseProfileArray(raw, 2),
    retiredIds,
    acceptedOverrides
  }
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
  // Drop this teammate's override acceptances. Its override files are removed
  // with it and its id is retired, so the entries can never grant anything
  // again — keeping them would only grow the ledger forever.
  const suffix = `\u0000${request.id}`
  const acceptedOverrides = Object.fromEntries(
    Object.entries(file.acceptedOverrides).filter(([key]) => !key.endsWith(suffix))
  )
  writeProfiles({
    version: PROFILES_VERSION,
    profiles,
    retiredIds: [...new Set([...file.retiredIds, request.id])],
    acceptedOverrides
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
/**
 * One read of the override file, yielding both its parsed contents and the
 * digest consent is recorded against — two reads would let the bytes change
 * between parsing them and hashing them.
 */
type OverrideFile = { digest: string; override: AgentProfileOverride | null }

function readOverrideFile(workspacePath: string, profileId: string): OverrideFile | null {
  const path = workspaceOverridePath(workspacePath, profileId)
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    // No file is the ordinary case, not a fault.
    return null
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  try {
    const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
    // Identity/ownership fields are global-owned: a workspace file can never
    // rename a teammate, change its id/timestamps, or move its scope.
    delete raw.id
    delete raw.name
    delete raw.createdAt
    delete raw.updatedAt
    delete raw.scope
    delete raw.workspacePath
    const patch = AgentProfileOverrideSchema.parse(raw)
    return { digest, override: Object.keys(patch).length > 0 ? patch : null }
  } catch (err) {
    logger.warn('Ignoring invalid workspace profile override', {
      scope: 'agentProfiles',
      path,
      err
    })
    return { digest, override: null }
  }
}

/**
 * Consent key. Mirrors `workspacePathsEqual`, so a workspace reopened under a
 * different spelling — drive casing, separators — is still the same consent
 * rather than silently re-prompting.
 */
function overrideAcceptKey(workspacePath: string, profileId: string): string {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  const ws = isWindowsStylePath(canonical) ? canonical.toLowerCase() : canonical
  return `${ws}\u0000${profileId}`
}

function isOverrideAccepted(workspacePath: string, profileId: string, digest: string): boolean {
  return loadProfiles().acceptedOverrides[overrideAcceptKey(workspacePath, profileId)] === digest
}

/**
 * Privileged fields this workspace's override asks for but has not been
 * granted — exactly what `resolveAgentProfile` is dropping.
 */
export function unacceptedOverrideFields(workspacePath: string, profileId: string): string[] {
  const read = readOverrideFile(workspacePath, profileId)
  if (!read?.override) return []
  const wanted = PRIVILEGED_OVERRIDE_FIELDS.filter((f) => read.override?.[f] !== undefined)
  if (wanted.length === 0) return []
  return isOverrideAccepted(workspacePath, profileId, read.digest) ? [] : [...wanted]
}

/**
 * Record consent for this workspace's override file as it stands right now.
 *
 * Main-only, like `setMarketplaceRemoteInstallAcked`: nothing reachable from a
 * generic setter may grant a project the right to run a teammate
 * autonomously. The digest is taken here rather than accepted from the caller,
 * so a renderer cannot approve bytes it invented.
 */
export function acceptWorkspaceProfileOverride(workspacePath: string, profileId: string): void {
  assertSafeMemoryNamespace(profileId)
  const read = readOverrideFile(workspacePath, profileId)
  if (!read) throw new Error('There is no override file to accept')
  const file = loadProfiles()
  writeProfiles({
    ...file,
    acceptedOverrides: {
      ...file.acceptedOverrides,
      [overrideAcceptKey(workspacePath, profileId)]: read.digest
    }
  })
}

export function readWorkspaceProfileOverride(
  workspacePath: string | null | undefined,
  profileId: string
): AgentProfileOverride | null {
  if (!workspacePath) return null
  return readOverrideFile(workspacePath, profileId)?.override ?? null
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
 * Privileged fields each override in this workspace is asking for but has not
 * been granted, keyed by profile id. Ids with nothing withheld are omitted.
 */
export function listUnacceptedOverrideFields(
  workspacePath: string
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const profileId of Object.keys(listWorkspaceProfileOverrides(workspacePath))) {
    const fields = unacceptedOverrideFields(workspacePath, profileId)
    if (fields.length > 0) out[profileId] = fields
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
  const read = workspacePath ? readOverrideFile(workspacePath, profileId) : null
  const override = read?.override
  if (!read || !override) return base
  const applied: AgentProfileOverride = { ...override }
  // Accept-on-first-sight: until the user has granted THIS file, the fields
  // that decide when and how autonomously code runs are dropped. A cloned
  // repository can still retune persona, tone and the model pin — that is what
  // overrides are for — but it cannot lower the approval bar on its own.
  //
  // Dropping rather than refusing the run, and checking here rather than
  // prompting, because every caller of this function is a synchronous run or
  // queue path — `taskScheduler.startTask` runs inside `launchRunSync`'s
  // no-await claim window. There is nowhere here to await a dialog.
  if (workspacePath && !isOverrideAccepted(workspacePath, profileId, read.digest)) {
    const withheld = PRIVILEGED_OVERRIDE_FIELDS.filter((f) => applied[f] !== undefined)
    if (withheld.length > 0) {
      for (const field of withheld) delete applied[field]
      logger.warn('Withholding unaccepted privileged override fields', {
        scope: 'agentProfiles',
        workspacePath,
        profileId,
        fields: withheld
      })
    }
  }
  if (Object.keys(applied).length === 0) return base
  return AgentProfileSchema.parse({
    ...base,
    ...applied,
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
      overrides: listWorkspaceProfileOverrides(workspacePath),
      unaccepted: listUnacceptedOverrideFields(workspacePath)
    })
  } catch (err) {
    logger.warn('Failed to emit agent profile overrides change', { scope: 'agentProfiles', err })
  }
}
