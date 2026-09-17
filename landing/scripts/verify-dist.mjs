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
ok('dist/index.html exists', hasHome);
ok('dist/changelog/index.html exists', hasChangelog);
if (!hasHome || !hasChangelog) {
  console.error('verify-dist: missing pages, aborting');
  process.exit(1);
}

const home = read('dist/index.html');
const chlog = read('dist/changelog/index.html');

// 2. Landing structure — single full-screen page
ok('download row', home.includes('id="download"'));
ok('ascii accent', home.includes('data-ascii'));
ok('app screenshot', home.includes('data-shot'));
ok('nav changelog link', home.includes('href="/changelog"'));
ok('no dead CHANGELOG.md links', !/CHANGELOG\.md/.test(home) && !/CHANGELOG\.md/.test(chlog));
ok('no localhost refs', !/localhost/.test(home) && !/localhost/.test(chlog));

// 3. Installer links — every baked asset must appear; no invented URLs
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
    ok(`installer baked: ${label}`, asset !== null && home.includes(asset.url));
  }
  ok('download fallback not shown', !home.includes('No installer yet'));
} else {
  ok('fallback links releases page', home.includes(release.url));
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
