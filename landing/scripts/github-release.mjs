export const RELEASES_PAGE = 'https://github.com/vyotiqai/vyotiq-agent-v/releases/latest'
export const RELEASES_API =
  'https://api.github.com/repos/vyotiqai/vyotiq-agent-v/releases/latest'
export const RELEASES_LIST_API =
  'https://api.github.com/repos/vyotiqai/vyotiq-agent-v/releases?per_page=10'

export const EMPTY_GITHUB_RELEASE = {
  tag: null,
  version: null,
  htmlUrl: RELEASES_PAGE,
  assets: {}
}

function httpsUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') ? value : null
}

function classifyInstaller(name) {
  if (typeof name !== 'string' || !name) return null
  if (name.endsWith('.blockmap') || /\.ya?ml$/i.test(name)) return null
  if (name.endsWith('-setup.exe')) return 'win'
  if (name.endsWith('.dmg')) return 'mac'
  if (name.endsWith('.AppImage')) return 'linux'
  return null
}

export function hasReleaseAssets(mapped) {
  return Boolean(
    mapped?.assets?.win ||
      mapped?.assets?.mac ||
      mapped?.assets?.macArm64 ||
      mapped?.assets?.macX64 ||
      mapped?.assets?.linux
  )
}

/** Keep a previously baked snapshot when a fetch returns nothing usable. */
export function preferExistingSnapshot(candidate, existing) {
  if (hasReleaseAssets(candidate)) return candidate
  if (hasReleaseAssets(existing)) return existing
  return candidate ?? { ...EMPTY_GITHUB_RELEASE, assets: {} }
}

export function sanitizeSnapshot(value) {
  if (value == null || typeof value !== 'object') {
    return { ...EMPTY_GITHUB_RELEASE, assets: {} }
  }
  const parsed = value
  const htmlUrl = httpsUrl(parsed.htmlUrl) ?? RELEASES_PAGE
  const assets = {}
  for (const id of ['win', 'mac', 'linux']) {
    const asset = parsed.assets?.[id]
    const name = typeof asset?.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset?.url)
    if (name && url && classifyInstaller(name)) assets[id] = { name, url }
  }
  // Per-arch mac fields keep the -mac.zip Intel fallback, so gate on the
  // artifact shape instead of classifyInstaller (which only knows .dmg).
  for (const id of ['macArm64', 'macX64']) {
    const asset = parsed.assets?.[id]
    const name = typeof asset?.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset?.url)
    const shape = id === 'macArm64' ? /\.dmg$/i : /\.(dmg|zip)$/i
    if (name && url && shape.test(name)) assets[id] = { name, url }
  }
  return {
    tag: typeof parsed.tag === 'string' && parsed.tag.trim() ? parsed.tag.trim() : null,
    version: typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : null,
    htmlUrl,
    assets
  }
}

/** Pick the DMG to advertise for mac: arm64 (Apple Silicon majority) first,
 * then the legacy arch-less name, then any remaining arch DMG. */
function pickMacDmg(candidates) {
  const arm64 = candidates.find((candidate) => candidate.name.endsWith('-arm64.dmg'))
  if (arm64) return arm64
  const legacy = candidates.find((candidate) => !/-[a-z0-9]+\.dmg$/i.test(candidate.name))
  if (legacy) return legacy
  return candidates[0] ?? null
}

/** Map a GitHub release JSON payload to packaged NSIS / DMG / AppImage assets. */
export function mapGithubRelease(release) {
  if (release == null || typeof release !== 'object' || release.draft === true) {
    return { ...EMPTY_GITHUB_RELEASE, assets: {} }
  }

  const tag = typeof release.tag_name === 'string' && release.tag_name.trim() ? release.tag_name.trim() : null
  const version = tag ? tag.replace(/^v/i, '') : null
  const htmlUrl = httpsUrl(release.html_url) ?? RELEASES_PAGE
  const list = Array.isArray(release.assets) ? release.assets : []
  const expected = version
    ? {
        win: `Vyotiq-${version}-setup.exe`,
        linux: `Vyotiq-${version}.AppImage`
      }
    : null
  // electron-builder names per-arch mac DMGs `Vyotiq-<v>-<arch>.dmg` when a
  // release ships arm64 + x64; the arch-less name only appears for single-arch
  // (x64) mac builds, so match all three shapes and prefer arm64.
  const macPattern = version
    ? new RegExp(`^Vyotiq-${version}(?:-arm64|-x64)?\\.dmg$`, 'i')
    : null
  // Legacy single-archive mac upload shape: `Vyotiq-<v>-mac.zip`.
  const macZipPattern = version ? new RegExp(`^Vyotiq-${version}-mac\\.zip$`, 'i') : null

  const assets = {}
  const macCandidates = []
  const macZipCandidates = []
  for (const asset of list) {
    if (asset == null || typeof asset !== 'object') continue
    const name = typeof asset.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset.browser_download_url)
    if (!name || !url) continue
    if (expected && name === expected.win) assets.win = { name, url }
    else if (expected && name === expected.linux) assets.linux = { name, url }
    else if (macPattern && macPattern.test(name)) macCandidates.push({ name, url })
    else if (macZipPattern && macZipPattern.test(name)) macZipCandidates.push({ name, url })
  }
  const macArm64 = macCandidates.find((candidate) => candidate.name.endsWith('-arm64.dmg')) ?? null
  const macX64 =
    macCandidates.find((candidate) => candidate.name.endsWith('-x64.dmg')) ??
    macZipCandidates[0] ??
    null
  // Legacy `mac` field stays = the arm64 image when one ships (pickMacDmg
  // prefers -arm64.dmg), falling back to the single-arch shape.
  const mac = pickMacDmg(macCandidates)
  if (macArm64) assets.macArm64 = macArm64
  if (macX64) assets.macX64 = macX64
  if (mac) assets.mac = mac

  for (const asset of list) {
    if (asset == null || typeof asset !== 'object') continue
    const name = typeof asset.name === 'string' ? asset.name : ''
    const url = httpsUrl(asset.browser_download_url)
    const platform = classifyInstaller(name)
    if (!platform || !url || assets[platform]) continue
    if (platform === 'mac') {
      if (!assets.mac) {
        const picked = pickMacDmg([{ name, url }, ...macCandidates])
        if (picked) assets.mac = picked
      }
      if (!assets.macArm64 && /-arm64\.dmg$/i.test(name)) assets.macArm64 = { name, url }
      else if (!assets.macX64 && /-x64\.dmg$/i.test(name)) assets.macX64 = { name, url }
      continue
    }
    assets[platform] = { name, url }
  }

  return { tag, version, htmlUrl, assets }
}

export function pickPublishedRelease(releases) {
  if (!Array.isArray(releases)) return null
  return (
    releases.find(
      (release) => release && release.draft !== true && hasReleaseAssets(mapGithubRelease(release))
    ) ?? null
  )
}
