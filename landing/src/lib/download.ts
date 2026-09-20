import { release } from './site'

/**
 * Shapes the baked release assets into the platform groups the download page
 * renders. Every entry comes from the GitHub API response; no filename is
 * constructed here.
 */

export type Installer = {
  name: string
  url: string
  size: number
  downloadCount: number
  platform: 'windows' | 'macos' | 'linux'
  arch: 'x64' | 'arm64'
  format: string
  label: string
}

export type PlatformGroup = {
  id: 'windows' | 'macos' | 'linux'
  label: string
  /** Matched against the UA at runtime to pick the primary CTA. */
  detect: string
  note: string
  variants: { heading: string; arch: string; installers: Installer[] }[]
}

const installers = release.installers as Installer[]

export const HAS_RELEASE = release.source === 'github' && installers.length > 0

const byPlatform = (p: Installer['platform']) => installers.filter((i) => i.platform === p)
const byArch = (p: Installer['platform'], arch: Installer['arch']) =>
  byPlatform(p).filter((i) => i.arch === arch)

export const PLATFORMS: PlatformGroup[] = [
  {
    id: 'windows',
    label: 'Windows',
    detect: 'windows',
    note: '64-bit (x64). Installs per-user — no administrator rights needed.',
    variants: [{ heading: 'Windows', arch: 'x64', installers: byArch('windows', 'x64') }]
  },
  {
    id: 'macos',
    label: 'macOS',
    detect: 'macos',
    note: 'Separate builds per architecture — there is no universal binary.',
    variants: [
      { heading: 'Apple silicon', arch: 'arm64', installers: byArch('macos', 'arm64') },
      { heading: 'Intel', arch: 'x64', installers: byArch('macos', 'x64') }
    ]
  },
  {
    id: 'linux',
    label: 'Linux',
    detect: 'linux',
    note: '64-bit (x86_64). AppImage runs anywhere; deb and rpm integrate with your package manager.',
    variants: [{ heading: 'Linux', arch: 'x86_64', installers: byArch('linux', 'x64') }]
  }
].filter((p) => p.variants.some((v) => v.installers.length > 0)) as PlatformGroup[]

/** Update manifests the in-app updater reads. Listed for transparency. */
export const FEEDS = release.feeds as { name: string; url: string; size: number }[]

export const RELEASE_META = {
  version: release.version,
  tag: release.tag,
  publishedAt: release.publishedAt,
  htmlUrl: release.htmlUrl,
  installerCount: installers.length
}
