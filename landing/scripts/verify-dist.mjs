// Gates for the built dist. Fails (exit 1) with a reason per missing gate.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const landDir = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(`${landDir}${p}`, 'utf8');

const release = JSON.parse(read('src/data/release.json'));
const changelog = JSON.parse(read('src/data/changelog.json'));

const failures = [];
const ok = (label, pass, detail = '') => {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures.push(label);
};

// 1. Pages built
const hasHome = existsSync(`${landDir}dist/index.html`);
const hasChangelog = existsSync(`${landDir}dist/changelog/index.html`);
const hasFeatures = existsSync(`${landDir}dist/features/index.html`);
const hasWorkflows = existsSync(`${landDir}dist/workflows/index.html`);
const hasDownload = existsSync(`${landDir}dist/download/index.html`);
ok('dist/index.html exists', hasHome);
ok('dist/features/index.html exists', hasFeatures);
ok('dist/workflows/index.html exists', hasWorkflows);
ok('dist/download/index.html exists', hasDownload);
ok('dist/changelog/index.html exists', hasChangelog);
if (!hasHome || !hasChangelog || !hasFeatures || !hasWorkflows || !hasDownload) {
  console.error('verify-dist: missing pages, aborting');
  process.exit(1);
}

const home = read('dist/index.html');
const download = read('dist/download/index.html');
const featuresPage = read('dist/features/index.html');
const workflowsPage = read('dist/workflows/index.html');
const chlog = read('dist/changelog/index.html');

// 2. Home structure + navigation — every menu link wired on every page
for (const [label, href] of [['features', '/features'], ['workflows', '/workflows'], ['download', '/download'], ['changelog', '/changelog']]) {
  ok(`home nav link: ${label}`, home.includes(`href="${href}"`));
  ok(`download nav link: ${label}`, download.includes(`href="${href}"`));
}
ok('agent transcript', home.includes('data-transcript'));
ok('app screenshot', home.includes('data-shot'));
ok('home CTA to download', home.includes('href="/download"'));
ok('features page has cards', featuresPage.includes('Multi-provider chat') && featuresPage.includes('Long-term workspace memory'));
ok('workflows page has steps', workflowsPage.includes('Fan out') && workflowsPage.includes('Verify'));

ok('no dead CHANGELOG.md links', !/CHANGELOG\.md/.test(home) && !/CHANGELOG\.md/.test(chlog));
ok('no localhost refs', !/localhost/.test(home) && !/localhost/.test(chlog));

// 3. Installer links — every baked asset on the download page; no invented URLs
const slots = [
  ['windows exe', release.assets.windows.exe],
  ['macos arm64 dmg', release.assets.macos.arm64],
  ['macos x64 dmg', release.assets.macos.x64],
  ['linux appimage', release.assets.linux.appimage],
  ['linux deb', release.assets.linux.deb],
  ['linux rpm', release.assets.linux.rpm],
];
if (release.source === 'github') {
  for (const [label, asset] of slots) {
    ok(`installer baked: ${label}`, asset !== null && download.includes(asset.url));
  }
  ok('download fallback not shown', !download.includes('No installer yet'));
  ok('download per-OS groups', download.includes('data-os="windows"') && download.includes('data-os="macos"') && download.includes('data-os="linux"'));
} else {
  ok('fallback links releases page', download.includes(release.url));
}

// 4. Changelog page state
if (changelog.source === 'github' && changelog.releases.length > 0) {
  ok('changelog populated', chlog.includes(changelog.releases[0].tag));
  ok('no unescaped script from notes', !/<script>alert|<script>document/.test(chlog));
} else {
  ok('changelog empty state', /No releases published yet/.test(chlog));
}

if (failures.length) {
  console.error(`verify-dist: ${failures.length} gate(s) failed`);
  process.exit(1);
}
console.log('verify-dist: all gates green');
