import { app } from 'electron'
import { existsSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import {
  AgentProfileBaseSchema,
  AgentProfileSchema,
  IPC,
  type AgentProfile,
  type AgentProfileCreateRequest,
  type AgentProfileDeleteRequest,
  type AgentProfileUpdateRequest
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '../storage/atomicWrite'
import { getMainWindow } from '../app/window'
import { enqueueSettingsMutation } from './settings'

/**
 * Global teammate roster. Profiles are the identity primitive referenced by
 * runs; the roster is one small JSON file next to settings.json. A workspace
 * may override individual fields of a global profile via
 * `.vyotiq/agents/<profileId>.profile.json` (per-field merge, git-shareable).
 */

const PROFILES_VERSION = 1

type AgentProfilesFile = {
  version: number
  profiles: AgentProfile[]
}

let profilesCache: AgentProfilesFile | null = null

function profilesPath(): string {
  return join(app.getPath('userData'), 'agents.json')
}

function emptyFile(): AgentProfilesFile {
  return { version: PROFILES_VERSION, profiles: [] }
}

function parseProfilesFile(raw: unknown): AgentProfilesFile {
  const parsed = raw as Partial<AgentProfilesFile> | null
  if (!parsed || !Array.isArray(parsed.profiles)) return emptyFile()
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
  return { version: PROFILES_VERSION, profiles }
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
  const taken = new Set(file.profiles.map((p) => p.id))
  const now = new Date().toISOString()
  const profile: AgentProfile = {
    ...request,
    scope: request.scope ?? 'global',
    id: uniqueId(slugifyName(request.name), taken),
    createdAt: now,
    updatedAt: now
  }
  const parsed = AgentProfileSchema.parse(profile)
  writeProfiles({ version: PROFILES_VERSION, profiles: [...file.profiles, parsed] })
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
  writeProfiles({ version: PROFILES_VERSION, profiles })
  return parsed
}

export function deleteAgentProfile(request: AgentProfileDeleteRequest): true {
  const file = loadProfiles()
  const profiles = file.profiles.filter((p) => p.id !== request.id)
  if (profiles.length === file.profiles.length) {
    throw new Error(`Unknown agent profile: ${request.id}`)
  }
  writeProfiles({ version: PROFILES_VERSION, profiles })
  return true
}

/**
 * Remove a deleted profile's workspace override files so a future profile with
 * the same slugified id cannot silently inherit the dead identity's overrides.
 * Best-effort per workspace; missing files are skipped.
 */
export function removeProfileOverridesForWorkspaces(
  profileId: string,
  workspacePaths: readonly string[]
): void {
  for (const workspacePath of workspacePaths) {
    const path = workspaceOverridePath(workspacePath, profileId)
    try {
      if (existsSync(path)) rmSync(path, { force: true })
    } catch (err) {
      logger.warn('Failed to remove workspace profile override', {
        scope: 'agentProfiles',
        path,
        err
      })
    }
  }
}

function workspaceOverridePath(workspacePath: string, profileId: string): string {
  return join(workspacePath, '.vyotiq', 'agents', `${profileId}.profile.json`)
}

/**
 * Per-workspace field overrides for a global profile, stored git-shareable at
 * `.vyotiq/agents/<profileId>.profile.json`. Only identity/behavior fields may
 * be overridden — id, timestamps, scope, and workspacePath stay global-owned.
 */
export function readWorkspaceProfileOverride(
  workspacePath: string | null | undefined,
  profileId: string
): Partial<AgentProfile> | null {
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
    const patch = AgentProfileBaseSchema.omit({ id: true, createdAt: true })
      .partial()
      .parse(raw)
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

/** Global profile with workspace overrides applied; null when the id is unknown. */
export function resolveAgentProfile(
  workspacePath: string | null | undefined,
  profileId: string
): AgentProfile | null {
  const base = getAgentProfile(profileId)
  if (!base) return null
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
