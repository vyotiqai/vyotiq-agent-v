// Bake the latest published release into src/data/release.json for the download section.
// Public repo — unauthenticated API by default; set GITHUB_TOKEN to raise rate limits.
// Always exits 0: on any failure writes a fallback manifest pointing at the releases page.
import { writeFileSync } from 'node:fs';

const REPO = 'vyotiqai/vyotiq-agent-v-releases';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const OUT_URL = new URL('../src/data/release.json', import.meta.url);
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;

const emptyAssets = () => ({
  windows: { exe: null },
  macos: { arm64: null, x64: null },
  linux: { appimage: null, deb: null, rpm: null },
});

function assetSlot(name) {
  if (/\.(blockmap|zip)$/i.test(name) || /^latest[-.]/i.test(name)) return null;
  if (/setup\.exe$/i.test(name)) return 'windows.exe';
  if (/arm64\.dmg$/i.test(name)) return 'macos.arm64';
  if (/x64\.dmg$/i.test(name)) return 'macos.x64';
  if (/\.appimage$/i.test(name)) return 'linux.appimage';
  if (/\.deb$/i.test(name)) return 'linux.deb';
  if (/\.rpm$/i.test(name)) return 'linux.rpm';
  return null;
}

function write(manifest, warn) {
  writeFileSync(OUT_URL, `${JSON.stringify(manifest, null, 2)}\n`);
  if (warn) console.warn(`[bake-release] ${warn}`);
}

function fallback(reason) {
  write(
    {
      source: 'fallback',
      reason,
      fetchedAt: new Date().toISOString(),
      tag: null,
      version: null,
      name: null,
      publishedAt: null,
      url: RELEASES_PAGE,
      assets: emptyAssets(),
    },
    `fallback manifest written (${reason})`,
  );
}

async function main() {
  const headers = { 'User-Agent': 'vyotiq-landing', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let res;
  try {
    res = await fetch(API_URL, { headers });
  } catch (err) {
    return fallback(`fetch failed: ${err?.message || err}`);
  }
  if (!res.ok) return fallback(`HTTP ${res.status}`);

  const releases = await res.json().catch(() => null);
  const rel = Array.isArray(releases) ? releases.find((r) => r && !r.draft && !r.prerelease) : null;
  if (!rel) return fallback('no published stable release');

  const assets = emptyAssets();
  for (const a of rel.assets ?? []) {
    const slot = assetSlot(a.name || '');
    if (!slot) continue;
    const [group, key] = slot.split('.');
    assets[group][key] = { file: a.name, url: a.browser_download_url, size: a.size };
  }

  write({
    source: 'github',
    fetchedAt: new Date().toISOString(),
    tag: rel.tag_name,
    version: rel.tag_name.replace(/^v/, ''),
    name: rel.name || rel.tag_name,
    publishedAt: rel.published_at,
    url: rel.html_url,
    assets,
  });

  const f = (x) => (x ? 'ok' : 'MISSING');
  console.log(
    `[bake-release] ${rel.tag_name}: exe=${f(assets.windows.exe)} arm64=${f(assets.macos.arm64)} x64=${f(assets.macos.x64)} appimage=${f(assets.linux.appimage)} deb=${f(assets.linux.deb)} rpm=${f(assets.linux.rpm)}`,
  );
}

await main();
