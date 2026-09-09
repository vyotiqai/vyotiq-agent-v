export const RELEASES_PAGE = 'https://github.com/vyotiqai/vyotiq-agent-v/releases/latest'

export type ReleaseAsset = {
  name: string
  url: string
}

export type GithubReleaseSnapshot = {
  tag: string | null
  version: string | null
  htmlUrl: string
  assets: {
    win?: ReleaseAsset
    mac?: ReleaseAsset
    macArm64?: ReleaseAsset
    macX64?: ReleaseAsset
    linux?: ReleaseAsset
  }
}

export const EMPTY_GITHUB_RELEASE: GithubReleaseSnapshot = {
  tag: null,
  version: null,
  htmlUrl: RELEASES_PAGE,
  assets: {}
}

const bakedModules = import.meta.glob('./github-release.json', { eager: true }) as Record<
  string,
  GithubReleaseSnapshot | { default: GithubReleaseSnapshot }
>

function httpsAsset(value: unknown): ReleaseAsset | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const record = value as { name?: unknown; url?: unknown }
  if (typeof record.name !== 'string' || typeof record.url !== 'string') return undefined
  if (!record.url.startsWith('https://')) return undefined
  return { name: record.name, url: record.url }
}

function sanitize(value: unknown): GithubReleaseSnapshot {
  if (value == null || typeof value !== 'object') {
    return { ...EMPTY_GITHUB_RELEASE, assets: {} }
  }
  const parsed = value as GithubReleaseSnapshot
  const htmlUrl =
    typeof parsed.htmlUrl === 'string' && parsed.htmlUrl.startsWith('https://')
      ? parsed.htmlUrl
      : RELEASES_PAGE
  return {
    tag: typeof parsed.tag === 'string' ? parsed.tag : null,
    version: typeof parsed.version === 'string' ? parsed.version : null,
    htmlUrl,
    assets: {
      win: httpsAsset(parsed.assets?.win),
      mac: httpsAsset(parsed.assets?.mac),
      macArm64: httpsAsset(parsed.assets?.macArm64),
      macX64: httpsAsset(parsed.assets?.macX64),
      linux: httpsAsset(parsed.assets?.linux)
    }
  }
}

function unwrap(
  mod: GithubReleaseSnapshot | { default: GithubReleaseSnapshot } | undefined
): GithubReleaseSnapshot {
  if (mod == null) return { ...EMPTY_GITHUB_RELEASE, assets: {} }
  if ('default' in mod && mod.default) return sanitize(mod.default)
  return sanitize(mod)
}

export const githubRelease = unwrap(Object.values(bakedModules)[0])

export function hasReleaseAssets(snapshot: GithubReleaseSnapshot = githubRelease): boolean {
  return Boolean(snapshot.assets.win || snapshot.assets.mac || snapshot.assets.linux)
}
