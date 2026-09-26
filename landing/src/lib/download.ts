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
  variants: { heading: string; arch: string; installers: Installer[] }[]
}

const installers = release.installers as Installer[]

export const HAS_RELEASE = release.source === 'github' && installers.length > 0

const byArch = (p: Installer['platform'], arch: Installer['arch']) =>
  installers.filter((i) => i.platform === p && i.arch === arch)

export const PLATFORMS: PlatformGroup[] = (
  [
    {
      id: 'windows',
      label: 'Windows',
      variants: [{ heading: '64-bit', arch: 'x64', installers: byArch('windows', 'x64') }]
    },
    {
      id: 'macos',
      label: 'macOS',
      variants: [
        { heading: 'Apple silicon', arch: 'arm64', installers: byArch('macos', 'arm64') },
        { heading: 'Intel', arch: 'x64', installers: byArch('macos', 'x64') }
      ]
    },
    {
      id: 'linux',
      label: 'Linux',
      variants: [{ heading: '64-bit', arch: 'x86_64', installers: byArch('linux', 'x64') }]
    }
  ] as PlatformGroup[]
)
  .map((p) => ({ ...p, variants: p.variants.filter((v) => v.installers.length > 0) }))
  .filter((p) => p.variants.length > 0)

/** What the download button picks for each system, in the page's script. */
export const PICKS = installers.map((i) => ({
  platform: i.platform,
  arch: i.arch,
  format: i.format,
  label: i.label,
  name: i.name,
  url: i.url,
  size: i.size
}))

export const RELEASE_META = {
  version: release.version,
  tag: release.tag,
  publishedAt: release.publishedAt,
  htmlUrl: release.htmlUrl,
  installerCount: installers.length
}
