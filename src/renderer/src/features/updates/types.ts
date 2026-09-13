/**
 * Local contract types for the in-app update card.
 *
 * The main-process updater + preload bridge (`window.vyotiq.updater`) are owned
 * by another workstream and implemented to this exact contract, so the shapes
 * live here instead of `src/shared` (which this feature must not modify).
 */

import type { IpcResult } from '@shared/ipc'

export interface UpdateNotesSection {
  heading: string
  items: string[]
}

export interface UpdateInfo {
  version: string
  releaseDate: string
  releaseName: string
  notesText: string
  notesSections: UpdateNotesSection[]
  /** GitHub release page for "Full release notes" links; '' when unknown. */
  releaseUrl?: string
}

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdaterState {
  status: UpdaterStatus
  info?: UpdateInfo
  progress?: UpdateProgress
  error?: string
}

export interface UpdaterBridge {
  check: () => Promise<IpcResult<UpdateInfo | null>>
  download: () => Promise<IpcResult<undefined>>
  install: () => Promise<IpcResult<undefined>>
  onState: (cb: (s: UpdaterState) => void) => () => void
}
