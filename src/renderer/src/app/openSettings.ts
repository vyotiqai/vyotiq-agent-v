import type { SettingsSection } from '@renderer/features/settings/types'

const OPEN_SETTINGS_EVENT = 'vyotiq:open-settings'

/**
 * Opens Settings at a section from anywhere in the window — a toast's action,
 * a card deep in the record — without threading a handler down to it. The app
 * shell is the one listener.
 */
export function requestOpenSettings(section: SettingsSection): void {
  window.dispatchEvent(new CustomEvent<{ section: SettingsSection }>(OPEN_SETTINGS_EVENT, { detail: { section } }))
}

/** The shell's side: calls `open` with each requested section. Returns the unsubscribe. */
export function onOpenSettingsRequest(open: (section: SettingsSection) => void): () => void {
  const listener = (event: Event): void => {
    const section = (event as CustomEvent<{ section?: SettingsSection }>).detail?.section
    if (section) open(section)
  }
  window.addEventListener(OPEN_SETTINGS_EVENT, listener)
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener)
}
