// Verifies the built landing embeds expected Agent V content + design tokens.
// Usage: node scripts/verify-dist.mjs
import crypto from 'node:crypto';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';

const landingRoot = path.join(import.meta.dirname, '..');
const dist = path.join(landingRoot, 'dist');
const repoRoot = path.resolve(landingRoot, '..');
const html = await readFile(path.join(dist, 'index.html'), 'utf8');

async function collectCss() {
  const chunks = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.css')) chunks.push(await readFile(p, 'utf8'));
    }
  }
  await walk(dist);
  return chunks.join('\n');
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const css = await collectCss();
const all = html + '\n' + css;

const illustrative = (html.match(/Illustrative UI/g) ?? []).length;
const hasVideo = (html.match(/<video/g) ?? []).length;
const hasMp4 = (html.match(/\.mp4/g) ?? []).length;
const hasFinalCta = html.includes('Try Agent V now');
const hasFeatures = html.includes('id="features"') && html.includes('id="parallel"');
const hasAgentModes = html.includes('id="modes"');
const hasAgentBrowser = html.includes('id="browser"');
const hasMoreFeatures = html.includes('id="more-features"');
const hasProviders = html.includes('id="providers"');
const hasIntro = html.includes('id="intro"');
const hasLearnMore = html.includes('id="learn-more"');
const hasPillCta = css.includes('9999px') || all.includes('rounded-full') || css.includes('--av-pill');

const hasNewBg = all.includes('f7f7f4') || all.includes('--av-bg');
const hasOldBg = all.includes('faf9f7');
const hasOldAccent = all.includes('ea580c') || all.includes('234 88 12');
const hasNewAccent = all.includes('f54e00') || all.includes('--av-accent');
const hasNav52 = html.includes('52px');
const hasBlurNav = (html.match(/backdrop-blur/g) ?? []).length;

const splitIdx = html.indexOf('av-cta-split');
const menuIdx = html.indexOf('id="os-download-menu"');
const osMenuOutsideSplit = menuIdx > 0 && splitIdx > 0 && menuIdx > splitIdx;

async function routeExists(name) {
  if (await exists(path.join(dist, name, 'index.html'))) return true;
  if (await exists(path.join(dist, `${name}.html`))) return true;
  return false;
}

const routes = {
  features: await routeExists('features'),
  docs: await routeExists('docs'),
  download: await routeExists('download'),
  changelog: await routeExists('changelog'),
  legal: await routeExists('legal'),
  license: await routeExists('license'),
  notice: await routeExists('notice'),
  security: await routeExists('security'),
  'code-of-conduct': await routeExists('code-of-conduct'),
  contributing: await routeExists('contributing'),
  privacy: await routeExists('privacy'),
  terms: await routeExists('terms'),
};

console.log(
  `verify-dist: FinalCta=${hasFinalCta} Features=${hasFeatures} Modes=${hasAgentModes} Browser=${hasAgentBrowser} More=${hasMoreFeatures} Providers=${hasProviders} Intro=${hasIntro} LearnMore=${hasLearnMore}`,
);
console.log(
  `verify-dist: tokens bg=${hasNewBg} accent=${hasNewAccent} nav52=${hasNav52} oldBg=${hasOldBg} oldAccent=${hasOldAccent} blur=${hasBlurNav}`,
);
console.log(`verify-dist: osMenuOutsideSplit=${osMenuOutsideSplit}`);
console.log(`verify-dist: routes`, routes);
console.log(`verify-dist: 'Illustrative UI' occurrences=${illustrative} (expect 0)`);
console.log(`verify-dist: <video> elements=${hasVideo} (expect 0)`);
console.log(`verify-dist: .mp4 references=${hasMp4} (expect 0)`);

const routesOk = Object.values(routes).every(Boolean);

const ok =
  hasFinalCta &&
  hasFeatures &&
  hasAgentModes &&
  hasAgentBrowser &&
  hasMoreFeatures &&
  hasProviders &&
  hasIntro &&
  hasLearnMore &&
  hasNewBg &&
  hasNewAccent &&
  hasNav52 &&
  !hasOldBg &&
  !hasOldAccent &&
  hasBlurNav === 0 &&
  illustrative === 0 &&
  hasVideo === 0 &&
  hasMp4 === 0 &&
  osMenuOutsideSplit &&
  routesOk;

if (!ok) {
  console.error('verify-dist: FAILED');
  process.exit(1);
}

const legalManifestPath = path.join(landingRoot, 'src', 'data', 'legal-manifest.json');
if (!(await exists(legalManifestPath))) {
  console.error('verify-dist: missing legal-manifest.json (run bake-legal)');
  process.exit(1);
}
const legalManifest = JSON.parse(await readFile(legalManifestPath, 'utf8'));

for (const file of legalManifest.files) {
  const publicFile = path.join(dist, 'legal', path.basename(file.publicPath));
  if (!(await exists(publicFile))) {
    console.error(`verify-dist: missing baked legal file ${file.publicPath}`);
    process.exit(1);
  }
  const buf = await readFile(publicFile);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== file.sha256) {
    console.error(`verify-dist: sha256 mismatch for ${file.publicPath}`);
    process.exit(1);
  }
  const repoFile = path.join(repoRoot, file.source);
  const repoSha = crypto.createHash('sha256').update(await readFile(repoFile)).digest('hex');
  if (repoSha !== file.sha256) {
    console.error(`verify-dist: dist legal file does not match repo ${file.source}`);
    process.exit(1);
  }
  const pageHtml = await readFile(path.join(dist, file.route.replace(/^\//, ''), 'index.html'), 'utf8');
  if (!pageHtml.includes(file.source) || !pageHtml.includes(file.sha256.slice(0, 12))) {
    console.error(`verify-dist: ${file.route} page missing source provenance`);
    process.exit(1);
  }
}

const legalHub = await readFile(path.join(dist, 'legal', 'index.html'), 'utf8');
for (const absent of legalManifest.absentFromRepo) {
  if (!legalHub.includes(absent)) {
    console.error(`verify-dist: /legal hub missing absent-file disclosure ${absent}`);
    process.exit(1);
  }
}

console.log('verify-dist: legal', {
  files: legalManifest.files.length,
  spdx: legalManifest.spdxLicense,
  routes: ['legal', 'license', 'notice', 'privacy', 'terms', 'security', 'code-of-conduct', 'contributing'],
});
console.log('verify-dist: OK');
