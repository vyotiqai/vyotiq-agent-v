import { pushToast } from '@renderer/lib/ui/toastStore'

/**
 * In-app help: the keyboard-shortcuts list and the user documentation.
 * Open requests come from the palette and the keyboard; the dialog that
 * answers them is mounted once, in the app shell.
 */

const shortcutsRequests = new Set<() => void>()

/** Register the mounted shortcuts list; returns the unregister. */
export function onShortcutsHelpRequest(open: () => void): () => void {
  shortcutsRequests.add(open)
  return () => {
    shortcutsRequests.delete(open)
  }
}

/** Show the keyboard shortcuts. False when nothing is mounted to show them. */
export function requestShortcutsHelp(): boolean {
  if (shortcutsRequests.size === 0) return false
  for (const open of shortcutsRequests) open()
  return true
}

/** Used only when the app could not say where its homepage is. */
const FALLBACK_HOMEPAGE = 'https://vyotiq.com'

/** The user docs: `/docs` on the homepage main reports, as Settings → About opens it. */
export function documentationUrl(homepage: string | null | undefined): string {
  try {
    return new URL('/docs', homepage || FALLBACK_HOMEPAGE).href
  } catch {
    return new URL('/docs', FALLBACK_HOMEPAGE).href
  }
}

/** Open the user documentation in the browser. Resolves with an error message, or null. */
export async function openDocumentationUrl(): Promise<string | null> {
  const api = window.vyotiq
  if (!api?.shellOpenExternal) return 'Opening links is unavailable.'
  let homepage: string | null = null
  try {
    const info = await api.getAppInfo?.()
    if (info?.ok) homepage = info.data.homepage
  } catch {
    // The fallback homepage is the same site.
  }
  try {
    const res = await api.shellOpenExternal(documentationUrl(homepage))
    return res.ok ? null : res.error
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Open the user documentation; a failure is said in a toast. */
export function openDocumentation(): void {
  void openDocumentationUrl().then((error) => {
    if (error) pushToast(`The documentation couldn’t be opened: ${error}`, 'error')
  })
}
