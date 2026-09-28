import { shell, systemPreferences } from 'electron'
import type { DictationMicAccess } from '../../shared/ipc'

/**
 * The OS's microphone switch, where Electron can read it (Windows, macOS).
 * `denied` here is the reason getUserMedia fails, so the take can say which
 * switch to turn on instead of "permission denied".
 */
export function dictationMicAccess(): DictationMicAccess {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return 'unknown'
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    switch (status) {
      case 'granted':
      case 'denied':
      case 'restricted':
      case 'not-determined':
        return status
      default:
        return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

const MIC_SETTINGS_URL: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'ms-settings:privacy-microphone',
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

/** Open the OS page with the microphone switches. False where there is no such page. */
export async function openMicSettings(): Promise<boolean> {
  const url = MIC_SETTINGS_URL[process.platform]
  if (!url) return false
  await shell.openExternal(url)
  return true
}
