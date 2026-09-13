import { app, dialog, BrowserWindow } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  WorkspacesStateSchema,
  WorkspaceUiStateSchema,
  type WorkspacesState,
  type WorkspaceSettingsOverride,
  type WorkspaceUiState
} from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { validateCustomOpenAiBaseUrl } from '../../shared/providers'
import { canonicalizeWorkspacePath, workspacePathsEqual } from '../../shared/workspacePath'
import { interruptOrphanRuns } from '../agent/state'
import { clearSettingsCacheForTests, readLegacyWorkspacePath } from '@main/settings/settings'
import { atomicWriteJson } from '../storage/atomicWrite'
import { ensureWorkspaceStorage, workspaceId } from '../storage/paths'
import { migrateLegacySessions } from '@main/storage/migrations/migrateSessions'

const RECENT_MAX = 20
/** App-owned home workspace dir under Electron userData (never the OS profile root). */
const HOME_WORKSPACE_DIRNAME = 'home'

function workspacesPath(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

function userProfileRootPath(): string {
  try {
    return canonicalizeWorkspacePath(app.getPath('home'))
  } catch {
    return canonicalizeWorkspacePath(homedir())
  }
}

/** Previous auto-home location (`~/Vyotiq`) before it moved under userData. */
function legacyProfileHomeWorkspacePath(): string {
  return canonicalizeWorkspacePath(join(homedir(), 'Vyotiq'))
}

/**
 * Always-on home workspace — under app userData so it is never `C:\\Users\\…`
 * (the OS profile root).
 */
export function getHomeWorkspacePath(): string {
  return canonicalizeWorkspacePath(join(app.getPath('userData'), HOME_WORKSPACE_DIRNAME))
}

export function isHomeWorkspacePath(path: string): boolean {
  return workspacePathsEqual(path, getHomeWorkspacePath())
}

function remapPathIfPresent(state: WorkspacesState, from: string, to: string): WorkspacesState {
  if (workspacePathsEqual(from, to)) return state
  const present =
    state.openPaths.some((p) => workspacePathsEqual(p, from)) ||
    state.recentPaths.some((p) => workspacePathsEqual(p, from)) ||
    (state.activePath != null && workspacePathsEqual(state.activePath, from)) ||
    Object.keys(state.uiStateByPath).some((p) => workspacePathsEqual(p, from)) ||
    Object.keys(state.workspaceIdsByPath ?? {}).some((p) => workspacePathsEqual(p, from)) ||
    Object.keys(state.settingsOverridesByPath).some((p) => workspacePathsEqual(p, from))
  if (!present) return state
  return remapWorkspacePath(state, from, to)
}

/**
 * Move misplaced home roots (OS profile / legacy ~/Vyotiq) onto the app home path.
 */
function repairHomeWorkspacePaths(state: WorkspacesState): WorkspacesState {
  const home = getHomeWorkspacePath()
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true })
  }

  let next = state
  const before = next

  const legacy = legacyProfileHomeWorkspacePath()
  next = remapPathIfPresent(next, legacy, home)

  const profileRoot = userProfileRootPath()
  // Auto-home must never be the bare user profile (e.g. C:\Users\admin).
  if (
    next.openPaths.length === 1 &&
    workspacePathsEqual(next.openPaths[0]!, profileRoot)
  ) {
    next = remapPathIfPresent(next, profileRoot, home)
  }

  if (next !== before && next.openPaths.some((p) => workspacePathsEqual(p, home))) {
    next = registerWorkspaceId(next, home)
  }

  return next
}

/**
 * When no project tabs are open, create and open the home workspace so the
 * composer is always backed by a real path (send + tools).
 */
export function ensureHomeWorkspace(state: WorkspacesState): WorkspacesState {
  const repaired = repairHomeWorkspacePaths(state)
  if (repaired.openPaths.length > 0) return repaired

  const root = getHomeWorkspacePath()
  if (workspacePathsEqual(root, userProfileRootPath())) {
    throw new Error('Home workspace path must not be the user profile root')
  }
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true })
  }

  let next = registerWorkspaceId(repaired, root)
  const alreadyOpen = Boolean(findOpenPath(next, root))
  if (!alreadyOpen) {
    void interruptOrphanRuns([root]).catch((err) => {
      logger.warn('Failed to interrupt orphan runs for home workspace', { scope: 'workspace', err })
    })
  }
  next = {
    ...touchRecent(next, root),
    openPaths: [root],
    activePath: root
  }
  return ensureUiState(next, root)
}

/**
 * Drop open tabs whose folders vanished (deleted outside the app). Keeps
 * recentPaths/uiState so re-adding the same path can restore drafts.
 */
function pruneMissingOpenWorkspaces(state: WorkspacesState): WorkspacesState {
  const openPaths = state.openPaths.filter((p) => existsSync(p))
  if (openPaths.length === state.openPaths.length) return state
  logger.warn('Pruned open workspace path(s) missing on disk', {
    scope: 'workspaces',
    code: 'WORKSPACE_MISSING'
  })
  let activePath = state.activePath
  if (activePath != null && !openPaths.some((p) => workspacePathsEqual(p, activePath!))) {
    activePath = openPaths[0] ?? null
  }
  return normalizeActivePath({ ...state, openPaths, activePath })
}

function cacheOrPersistHome(state: WorkspacesState, forcePersist: boolean): WorkspacesState {
  const repaired = pruneMissingOpenWorkspaces(repairHomeWorkspacePaths(normalizeActivePath(state)))
  if (repaired.openPaths.length === 0) {
    const withHome = ensureHomeWorkspace(repaired)
    writeWorkspacesAtomic(withHome)
    if (withHome.needsWorkspaceForMigration) {
      migrateLegacySessions()
      workspacesCache = null
      return readWorkspacesState()
    }
    return workspacesCache!
  }
  if (forcePersist || repaired !== state) {
    writeWorkspacesAtomic(repaired)
    return workspacesCache!
  }
  workspacesCache = WorkspacesStateSchema.parse(repaired)
  return workspacesCache
}

function defaultUiState(): WorkspaceUiState {
  return {
    activeRunId: null,
    openRunIds: [],
    scrollTop: 0,
    scrollTopByRunId: {},
    composerDraft: '',
    composerDraftByRunId: {},
    agentMode: 'agent',
    expansionsByRunId: {}
  }
}

export function defaultWorkspacesState(): WorkspacesState {
  return {
    version: 2,
    workspaceIdsByPath: {},
    legacySessionsMigrated: false,
    openPaths: [],
    activePath: null,
    recentPaths: [],
    uiStateByPath: {},
    settingsOverridesByPath: {}
  }
}

function writeWorkspacesAtomic(state: WorkspacesState): void {
  const validated = WorkspacesStateSchema.parse(state)
  atomicWriteJson(workspacesPath(), validated)
  workspacesCache = validated
}

let workspacesCache: WorkspacesState | null = null
/**
 * Last accepted UI write epoch + generation per workspace path (stale IPC
 * guard). A changed epoch means the renderer reloaded and its generation
 * counter restarted from 0 — the incoming write is accepted and re-seeds the
 * guard. Keying only on the generation silently dropped EVERY UI-state save
 * after an in-app reload (dev Ctrl+R, crash-recovery reload) until the fresh
 * counter happened to climb past the pre-reload generation.
 */
const lastUiWriteGenerationByPath = new Map<string, { epoch: string; gen: number }>()
/** Serializes async workspace mutations that may await between read and write. */
let workspacesMutationChain: Promise<unknown> = Promise.resolve()

export function enqueueWorkspaceMutation<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = workspacesMutationChain.then(() => fn())
  workspacesMutationChain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Drop in-memory workspaces cache (tests / external file edits). */
export function clearWorkspacesCacheForTests(): void {
  workspacesCache = null
  lastUiWriteGenerationByPath.clear()
}

function registerWorkspaceId(
  state: WorkspacesState,
  workspacePath: string
): WorkspacesState {
  const { workspaceId: id } = ensureWorkspaceStorage(workspacePath)
  return {
    ...state,
    workspaceIdsByPath: {
      ...state.workspaceIdsByPath,
      [workspacePath]: id
    }
  }
}

function upgradeWorkspacesStateV1(raw: Record<string, unknown>): WorkspacesState {
  const merged = mergePartialWorkspacesState(raw)
  const paths = dedupeRecent([...merged.openPaths, ...merged.recentPaths])
  const workspaceIdsByPath: Record<string, string> = { ...merged.workspaceIdsByPath }
  for (const p of paths) {
    const canonical = canonicalizeWorkspacePath(p)
    workspaceIdsByPath[canonical] = workspaceId(canonical)
  }
  return {
    ...merged,
    version: 2,
    workspaceIdsByPath
  }
}

function stripDeprecatedWorkspaceOverrides(state: WorkspacesState): WorkspacesState {
  const overrides = { ...state.settingsOverridesByPath }
  let stripped = false
  for (const [path, override] of Object.entries(overrides)) {
    if (!override || !('ollamaBaseUrl' in override)) continue
    const { ollamaBaseUrl: _removed, ...rest } = override as WorkspaceSettingsOverride & {
      ollamaBaseUrl?: string
    }
    overrides[path] = rest as WorkspaceSettingsOverride
    stripped = true
  }
  return stripped ? { ...state, settingsOverridesByPath: overrides } : state
}

function migrateLegacyWorkspacePath(state: WorkspacesState): WorkspacesState {
  const stripped = stripDeprecatedWorkspaceOverrides(state)
  if (stripped.openPaths.length > 0) return stripped
  const legacy = readLegacyWorkspacePath()
  if (!legacy || !existsSync(legacy)) return stripped
  const next: WorkspacesState = {
    ...stripped,
    openPaths: [legacy],
    activePath: legacy,
    recentPaths: dedupeRecent([legacy, ...stripped.recentPaths])
  }
  writeWorkspacesAtomic(next)
  logger.info('Migrated legacy settings.workspacePath to workspaces.json', {
    scope: 'workspaces',
    path: legacy
  })
  return next
}

function dedupeRecent(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p) continue
    const key = process.platform === 'win32' ? p.toLowerCase() : p
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= RECENT_MAX) break
  }
  return out
}

function mergePartialWorkspacesState(raw: Record<string, unknown>): WorkspacesState {
  const merged = defaultWorkspacesState()
  const shape = WorkspacesStateSchema.shape
  for (const key of Object.keys(shape) as (keyof WorkspacesState)[]) {
    const value = raw[key]
    const field = shape[key].safeParse(value)
    if (field.success) {
      ;(merged as Record<string, unknown>)[key] = field.data
    }
  }
  return normalizeActivePath(merged)
}

/** Clear or realign activePath when it is not among openPaths. */
function normalizeActivePath(state: WorkspacesState): WorkspacesState {
  if (state.activePath == null) {
    return state.openPaths.length > 0 ? { ...state, activePath: state.openPaths[0]! } : state
  }
  const match = state.openPaths.find((p) => workspacePathsEqual(p, state.activePath!))
  if (match) {
    return match === state.activePath ? state : { ...state, activePath: match }
  }
  return { ...state, activePath: state.openPaths[0] ?? null }
}

function findOpenPath(state: WorkspacesState, path: string): string | undefined {
  return state.openPaths.find((p) => workspacePathsEqual(p, path))
}

function remapWorkspacePath(state: WorkspacesState, from: string, to: string): WorkspacesState {
  if (workspacePathsEqual(from, to)) {
    if (from === to) return state
    return remapWorkspacePath(state, from, canonicalizeWorkspacePath(to))
  }

  const remapPath = (p: string | null): string | null => {
    if (p === null) return null
    return workspacePathsEqual(p, from) ? to : p
  }

  const remapList = (paths: string[]): string[] =>
    dedupeRecent(paths.map((p) => (workspacePathsEqual(p, from) ? to : p)))

  const uiStateByPath = { ...state.uiStateByPath }
  if (uiStateByPath[from] !== undefined) {
    uiStateByPath[to] = uiStateByPath[from]
    delete uiStateByPath[from]
  }

  const settingsOverridesByPath = { ...state.settingsOverridesByPath }
  if (settingsOverridesByPath[from] !== undefined) {
    settingsOverridesByPath[to] = settingsOverridesByPath[from]
    delete settingsOverridesByPath[from]
  }

  const workspaceIdsByPath = { ...state.workspaceIdsByPath }
  if (workspaceIdsByPath[from] !== undefined) {
    workspaceIdsByPath[to] = workspaceIdsByPath[from]
    delete workspaceIdsByPath[from]
  } else {
    workspaceIdsByPath[to] = workspaceId(canonicalizeWorkspacePath(to))
  }

  return {
    ...state,
    openPaths: remapList(state.openPaths),
    recentPaths: remapList(state.recentPaths),
    activePath: remapPath(state.activePath),
    uiStateByPath,
    settingsOverridesByPath,
    workspaceIdsByPath
  }
}

export function findWorkspaceSettingsOverride(
  state: WorkspacesState,
  workspacePath: string
): WorkspaceSettingsOverride | null {
  const canonical = canonicalizeWorkspacePath(workspacePath)
  for (const key of Object.keys(state.settingsOverridesByPath)) {
    if (workspacePathsEqual(key, canonical) || workspacePathsEqual(key, workspacePath)) {
      return state.settingsOverridesByPath[key] ?? null
    }
  }
  for (const p of state.openPaths) {
    if (workspacePathsEqual(p, canonical) || workspacePathsEqual(p, workspacePath)) {
      return state.settingsOverridesByPath[p] ?? null
    }
  }
  return null
}

function touchRecent(state: WorkspacesState, path: string): WorkspacesState {
  return {
    ...state,
    recentPaths: dedupeRecent([path, ...state.recentPaths.filter((p) => p !== path)])
  }
}

function ensureUiState(state: WorkspacesState, path: string): WorkspacesState {
  if (state.uiStateByPath[path]) return state
  return {
    ...state,
    uiStateByPath: {
      ...state.uiStateByPath,
      [path]: defaultUiState()
    }
  }
}

/**
 * Quarantine an unreadable workspaces.json to `workspaces.json.bak` and salvage
 * whatever parses from the backup. Returns null when nothing is recoverable —
 * the caller then starts fresh without ever overwriting the corrupt file.
 */
function quarantineCorruptWorkspacesFile(p: string): WorkspacesState | null {
  try {
    renameSync(p, `${p}.bak`)
  } catch (err) {
    logger.warn('Failed to quarantine corrupt workspaces.json', { scope: 'workspaces', err })
    return null
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(`${p}.bak`, 'utf8'))
    if (typeof raw === 'object' && raw !== null) {
      return mergePartialWorkspacesState(raw as Record<string, unknown>)
    }
  } catch {
    // Unrecoverable — preserved at .bak for manual recovery.
  }
  return null
}

export function readWorkspacesState(): WorkspacesState {
  if (workspacesCache) return workspacesCache
  const p = workspacesPath()
  if (!existsSync(p)) {
    return cacheOrPersistHome(migrateLegacyWorkspacePath(defaultWorkspacesState()), true)
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (typeof raw === 'object' && raw !== null && (raw as { version?: number }).version === 1) {
      return cacheOrPersistHome(
        normalizeActivePath(
          migrateLegacyWorkspacePath(upgradeWorkspacesStateV1(raw as Record<string, unknown>))
        ),
        true
      )
    }
    const parsed = WorkspacesStateSchema.safeParse(raw)
    if (!parsed.success) {
      logger.warn('workspaces.json schema mismatch; merging known fields', { scope: 'workspaces' })
      return cacheOrPersistHome(
        migrateLegacyWorkspacePath(
          mergePartialWorkspacesState(
            typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
          )
        ),
        true
      )
    }
    return cacheOrPersistHome(
      normalizeActivePath(migrateLegacyWorkspacePath(parsed.data)),
      false
    )
  } catch (err) {
    logger.warn('Failed to read workspaces.json; quarantining corrupt file', {
      scope: 'workspaces',
      err
    })
    const salvaged = quarantineCorruptWorkspacesFile(p)
    return cacheOrPersistHome(
      migrateLegacyWorkspacePath(salvaged ?? defaultWorkspacesState()),
      true
    )
  }
}

export function saveWorkspacesState(
  state: WorkspacesState,
  opts?: { pruneMissing?: boolean }
): WorkspacesState {
  // Prune-missing is for structural saves (add/remove/setActive). The
  // high-frequency UI-state save must not run it: a momentary existsSync
  // hiccup (OneDrive placeholder, network share) on an unrelated scroll/draft
  // write would permanently remove the workspace's open tab.
  const shouldPrune = opts?.pruneMissing ?? true
  let next = WorkspacesStateSchema.parse(
    shouldPrune
      ? pruneMissingOpenWorkspaces(normalizeActivePath(repairHomeWorkspacePaths(state)))
      : normalizeActivePath(repairHomeWorkspacePaths(state))
  )
  if (next.openPaths.length === 0) {
    next = WorkspacesStateSchema.parse(normalizeActivePath(ensureHomeWorkspace(next)))
  }
  writeWorkspacesAtomic(next)
  return next
}

export function getWorkspaces(): WorkspacesState {
  return readWorkspacesState()
}

export async function interruptOrphanRunsForWorkspaces(state: WorkspacesState): Promise<number> {
  const paths = dedupeRecent([...state.openPaths, ...state.recentPaths])
  return interruptOrphanRuns(paths)
}

export async function addWorkspace(
  win: BrowserWindow | null,
  path?: string
): Promise<WorkspacesState> {
  let root = path?.trim() ?? ''
  if (!root) {
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) {
      return readWorkspacesState()
    }
    root = result.filePaths[0]
  }
  if (!existsSync(root)) {
    throw new Error(`Workspace not found: ${root}`)
  }
  const st = statSync(root)
  if (!st.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`)
  }
  root = realpathSync(root)
  root = canonicalizeWorkspacePath(root)

  // Dialog stays outside the queue; persist RMW must share enqueueWorkspaceMutation
  // with remove / UI updates so an await mid-add cannot overwrite concurrent closes.
  return enqueueWorkspaceMutation(async () => {
    let state = readWorkspacesState()
    state = registerWorkspaceId(state, root)
    const alreadyOpen = Boolean(findOpenPath(state, root))
    // Only sweep crash orphans when first opening a workspace — re-activating an
    // already-open tab must not cancel in-flight runs (also guarded by isActive).
    if (!alreadyOpen) {
      await interruptOrphanRuns([root])
      // Re-read after await — other queued mutations may have landed.
      state = readWorkspacesState()
      state = registerWorkspaceId(state, root)
    }

    const existingOpen = findOpenPath(state, root)
    if (existingOpen && existingOpen !== root) {
      state = remapWorkspacePath(state, existingOpen, root)
    }

    if (!findOpenPath(state, root)) {
      state = {
        ...touchRecent(state, root),
        openPaths: [...state.openPaths, root],
        activePath: root
      }
    } else {
      state = { ...touchRecent(state, root), activePath: root }
    }
    state = ensureUiState(state, root)
    let saved = saveWorkspacesState(state)
    if (saved.needsWorkspaceForMigration) {
      migrateLegacySessions()
      saved = readWorkspacesState()
    }
    return saved
  })
}

export function removeWorkspace(path: string): WorkspacesState {
  const state = readWorkspacesState()
  const open = findOpenPath(state, path)
  if (!open) return state
  const openPaths = state.openPaths.filter((p) => !workspacePathsEqual(p, open))
  let activePath = state.activePath
  if (activePath != null && workspacePathsEqual(activePath, open)) {
    activePath = openPaths[0] ?? null
  }
  let next = saveWorkspacesState({
    ...state,
    openPaths,
    activePath
  })
  // Closing the last tab reopens home via saveWorkspacesState; migrate legacy if needed.
  if (openPaths.length === 0 && next.needsWorkspaceForMigration) {
    migrateLegacySessions()
    workspacesCache = null
    next = readWorkspacesState()
  }
  return next
}

export function setActiveWorkspace(path: string): WorkspacesState {
  let state = readWorkspacesState()
  let open = findOpenPath(state, path)
  if (!open) {
    // Activating a workspace that exists on disk but is not yet tracked
    // (e.g. a renderer-side path desync after a concurrent close). Open it
    // rather than hard-failing the switch.
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error('Workspace is not open')
    }
    state = registerWorkspaceId(state, path)
    if (!findOpenPath(state, path)) {
      state = {
        ...touchRecent(state, path),
        openPaths: [...state.openPaths, path],
        activePath: path
      }
    } else {
      state = { ...touchRecent(state, path), activePath: path }
    }
    state = ensureUiState(state, path)
    open = path
  } else {
    state = ensureUiState(touchRecent(state, open), open)
  }
  return saveWorkspacesState({ ...state, activePath: open })
}

export function updateWorkspaceUiState(path: string, ui: WorkspaceUiState): true {
  const parsed = WorkspaceUiStateSchema.parse(ui)
  const state = readWorkspacesState()
  const key = findOpenPath(state, path) ?? canonicalizeWorkspacePath(path)
  const incomingGen = parsed.writeGeneration
  if (incomingGen !== undefined) {
    const incomingEpoch = parsed.writeEpoch ?? ''
    const last = lastUiWriteGenerationByPath.get(key)
    if (last && last.epoch === incomingEpoch && incomingGen < last.gen) {
      return true
    }
    lastUiWriteGenerationByPath.set(key, { epoch: incomingEpoch, gen: incomingGen })
  }
  saveWorkspacesState(
    {
      ...state,
      uiStateByPath: {
        ...state.uiStateByPath,
        [key]: parsed
      }
    },
    { pruneMissing: false }
  )
  return true
}

export function setWorkspaceSettingsOverride(
  path: string,
  override: WorkspaceSettingsOverride | null
): WorkspacesState {
  const state = readWorkspacesState()
  const key = findOpenPath(state, path) ?? canonicalizeWorkspacePath(path)
  const settingsOverridesByPath = { ...state.settingsOverridesByPath }
  if (override === null) {
    delete settingsOverridesByPath[key]
  } else {
    // Write-boundary gate: a mangled base URL paste must never reach the
    // workspace override that catalog/chat resolve against (2026-09 audit).
    if (override.customOpenAiBaseUrl !== undefined) {
      const check = validateCustomOpenAiBaseUrl(override.customOpenAiBaseUrl)
      if (!check.ok) throw new Error(check.error)
    }
    // Merge into the stored override instead of replacing it. The renderer
    // builds its payload from a React snapshot; two writes in quick succession
    // (composer model pick + Settings thinking toggle) otherwise resurrect the
    // first write's stale model/thinking fields.
    const existing = settingsOverridesByPath[key]
    settingsOverridesByPath[key] = existing ? { ...existing, ...override } : override
  }
  return saveWorkspacesState({ ...state, settingsOverridesByPath })
}

export function patchWorkspacesState(patch: Partial<WorkspacesState>): WorkspacesState {
  const state = readWorkspacesState()
  return saveWorkspacesState({ ...state, ...patch })
}

/** Test helper — remove workspaces.json */
export function resetWorkspacesForTests(): void {
  workspacesCache = null
  // Legacy migration reads settings; drop that cache so disk edits in tests are visible.
  clearSettingsCacheForTests()
  const p = workspacesPath()
  if (existsSync(p)) {
    try {
      unlinkSync(p)
    } catch {
      // ignore
    }
  }
}
