import type { Settings } from '../../shared/ipc'
import { getSettings } from '../settings/settings'

/** The per-model limits from settings; none when settings cannot be read (headless tools, tests). */
export function modelLimitSettings(): Settings['modelLimits'] | undefined {
  try {
    return getSettings().modelLimits
  } catch {
    return undefined
  }
}
