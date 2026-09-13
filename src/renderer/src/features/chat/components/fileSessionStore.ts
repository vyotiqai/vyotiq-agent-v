import { useCallback, useSyncExternalStore } from 'react'
import type {
  WorkspaceEditorSelection,
  WorkspaceFileEncoding,
  WorkspaceFileEol,
  WorkspaceFileVersion
} from '@shared/ipc'

export type FileTab = {
  id: string
  path: string
  kind: 'text' | 'binary'
  content: string
  savedContent: string | null
  encoding: WorkspaceFileEncoding
  eol: WorkspaceFileEol
  bom: boolean
  version: WorkspaceFileVersion | null
  dirty: boolean
  conflict: boolean
  cursor: number
  selections: WorkspaceEditorSelection[]
  bookmarks: number[]
  template: string | null
  scrollTop: number
  revision: number
}

export type FileSession = {
  tabs: FileTab[]
  activeTabId: string | null
  selectedPath: string | null
  expandedPaths: string[]
  treeSort: 'name' | 'kind'
  showLineNumbers: boolean
  wordWrap: boolean
  autoSave: boolean
  formatOnSave: boolean
  /** Hide dependency/build noise (node_modules, dist, …) in the file tree. */
  showIgnoredFiles: boolean
  revision: number
}

export type FileSessionPatch = Partial<Omit<FileSession, 'revision'>>

const EMPTY_SESSION: FileSession = {
  tabs: [],
  activeTabId: null,
  selectedPath: null,
  expandedPaths: [''],
  treeSort: 'name',
  showLineNumbers: true,
  wordWrap: false,
  autoSave: true,
  formatOnSave: false,
  showIgnoredFiles: false,
  revision: 0
}

const sessions = new Map<string, FileSession>()
const lastUsed = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
export const MAX_FILE_SESSION_TABS = 32
export const MAX_FILE_SESSION_CONTENT_CHARS = 64 * 1024 * 1024
const MAX_SESSIONS = 8

function emptySession(): FileSession {
  return { ...EMPTY_SESSION, expandedPaths: [''] }
}

function notify(workspacePath: string): void {
  for (const listener of listeners.get(workspacePath) ?? []) listener()
}

export function getFileSession(workspacePath: string): FileSession {
  const existing = sessions.get(workspacePath)
  if (existing) {
    lastUsed.set(workspacePath, Date.now())
    return existing
  }
  if (sessions.size >= MAX_SESSIONS) {
    const clean = [...sessions.entries()]
      .filter(([, session]) => session.tabs.every((tab) => !tab.dirty))
      .sort(([a], [b]) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))[0]
    if (clean) {
      sessions.delete(clean[0])
      lastUsed.delete(clean[0])
    }
  }
  const created = emptySession()
  sessions.set(workspacePath, created)
  lastUsed.set(workspacePath, Date.now())
  return created
}

export function setFileSession(workspacePath: string, session: FileSession): void {
  sessions.set(workspacePath, session)
  lastUsed.set(workspacePath, Date.now())
  notify(workspacePath)
}

export function subscribeFileSession(
  workspacePath: string,
  listener: () => void
): () => void {
  const workspaceListeners = listeners.get(workspacePath) ?? new Set<() => void>()
  workspaceListeners.add(listener)
  listeners.set(workspacePath, workspaceListeners)
  return () => {
    workspaceListeners.delete(listener)
    if (workspaceListeners.size === 0) listeners.delete(workspacePath)
  }
}

export function useFileSession(workspacePath: string | null): FileSession {
  const subscribe = useCallback(
    (listener: () => void) =>
      workspacePath ? subscribeFileSession(workspacePath, listener) : () => undefined,
    [workspacePath]
  )
  const getSnapshot = useCallback(
    () => (workspacePath ? getFileSession(workspacePath) : EMPTY_SESSION),
    [workspacePath]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function clearFileSession(workspacePath: string): void {
  sessions.delete(workspacePath)
  lastUsed.delete(workspacePath)
  notify(workspacePath)
}
