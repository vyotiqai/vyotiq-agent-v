import { pushToast } from '@renderer/lib/ui/toastStore'

/**
 * Task bundles from the renderer: Export as JSON (the task as one file that
 * Import task… reads back) and Import task… (a bundle added to a workspace as
 * a new, finished, read-only task). Main owns the dialogs, the validation and
 * the writing; these say how it went.
 */

export async function exportTaskJson(workspacePath: string, runId: string): Promise<void> {
  const api = window.vyotiq?.exportRunJson
  if (!api) return
  try {
    const res = await api(workspacePath, runId)
    if (!res.ok) {
      pushToast(`Couldn’t export the task: ${res.error}`, 'error')
      return
    }
    if (res.data.saved && res.data.path) pushToast(`Task exported to ${res.data.path}`)
  } catch (err) {
    pushToast(`Couldn’t export the task: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/**
 * Pick a bundle and import it into `workspacePath`. Resolves with the new
 * task's id once it is on disk, or null when nothing was imported.
 */
export async function importTaskInto(workspacePath: string): Promise<string | null> {
  const api = window.vyotiq?.importRun
  if (!api) return null
  try {
    const res = await api(workspacePath)
    if (!res.ok) {
      pushToast(`Couldn’t import the task: ${res.error}`, 'error')
      return null
    }
    if (!res.data.imported || !res.data.runId) return null
    pushToast(`Imported “${res.data.title ?? 'task'}” — read-only; fork it to continue`, 'success')
    return res.data.runId
  } catch (err) {
    pushToast(`Couldn’t import the task: ${err instanceof Error ? err.message : String(err)}`, 'error')
    return null
  }
}
