// Bake published release notes into src/data/changelog.json for the /changelog page.
// Public repo — unauthenticated API by default; set GITHUB_TOKEN to raise rate limits.
// Always exits 0: on any failure writes a fallback the page renders as an empty state.
import { writeFileSync } from 'node:fs';

const REPO = 'vyotiqai/vyotiq-agent-v-releases';
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const OUT_URL = new URL('../src/data/changelog.json', import.meta.url);
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

function write(data, warn) {
  writeFileSync(OUT_URL, `${JSON.stringify(data, null, 2)}\n`);
  if (warn) console.warn(`[bake-changelog] ${warn}`);
}

async function main() {
  const headers = { 'User-Agent': 'vyotiq-landing', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  let res;
  try {
    res = await fetch(API_URL, { headers });
  } catch (err) {
    return write({ source: 'fallback', fetchedAt: new Date().toISOString(), url: RELEASES_PAGE, releases: [] }, `fetch failed: ${err?.message || err}`);
  }
  if (!res.ok) {
    return write({ source: 'fallback', fetchedAt: new Date().toISOString(), url: RELEASES_PAGE, releases: [] }, `HTTP ${res.status}`);
  }

  const releases = await res.json().catch(() => null);
  if (!Array.isArray(releases)) {
    return write({ source: 'fallback', fetchedAt: new Date().toISOString(), url: RELEASES_PAGE, releases: [] }, 'unexpected API payload');
  }

  const notes = releases
    .filter((r) => r && !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      publishedAt: r.published_at,
      url: r.html_url,
      prerelease: Boolean(r.prerelease),
      body: r.body || '',
    }));

  write({ source: 'github', fetchedAt: new Date().toISOString(), url: RELEASES_PAGE, releases: notes });
  console.log(`[bake-changelog] ${notes.length} release(s) baked`);
}

await main();
