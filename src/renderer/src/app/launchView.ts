export type LaunchSurface = 'home' | 'chat'

/**
 * Map the persisted `navigationMode` setting to the shell view on launch.
 * Unset or unrecognized values resolve to Home (the default surface).
 */
export function launchViewFor(
  navigationMode: 'home' | 'sidebar' | undefined | null
): LaunchSurface {
  return navigationMode === 'sidebar' ? 'chat' : 'home'
}
