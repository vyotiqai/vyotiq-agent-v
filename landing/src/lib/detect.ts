/**
 * Which desktop the visitor is on, for the download buttons. Runs in the
 * browser only. A phone or tablet gets null: there is no mobile build.
 */

export type Os = 'windows' | 'macos' | 'linux'

export const OS_LABEL: Record<Os, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

type UaData = {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const uaData = (): UaData | null => (navigator as Navigator & { userAgentData?: UaData }).userAgentData ?? null

export function detectOs(): Os | null {
  const ua = navigator.userAgent
  const hint = (uaData()?.platform ?? '').toLowerCase()

  if (/Android|iPhone|iPad|iPod/i.test(ua)) return null
  // iPadOS Safari reports a Mac user agent; a touch screen gives it away.
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return null

  if (hint.includes('win') || /Windows/i.test(ua)) return 'windows'
  if (hint.includes('mac') || /Mac OS X|Macintosh/i.test(ua)) return 'macos'
  if (hint.includes('linux') || /Linux|X11/i.test(ua)) return 'linux'
  return null
}

/**
 * True on an Arm CPU, false on x64, null when the browser will not say
 * (Safari and Firefox do not expose the architecture).
 */
export async function detectArm(): Promise<boolean | null> {
  const data = uaData()
  if (typeof data?.getHighEntropyValues !== 'function') return null
  try {
    const hints = await data.getHighEntropyValues(['architecture'])
    const arch = String(hints?.architecture ?? '').toLowerCase()
    if (!arch) return null
    return arch === 'arm' || arch === 'arm64'
  } catch {
    return null
  }
}
