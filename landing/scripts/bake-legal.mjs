import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const landingRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(landingRoot, '..');
const publicLegal = path.join(landingRoot, 'public', 'legal');
const dataOut = path.join(landingRoot, 'src', 'data', 'legal-manifest.json');

const FILES = [
  { id: 'license', source: 'LICENSE', publicName: 'LICENSE', route: '/license', title: 'GNU GPL v3', category: 'legal' },
  { id: 'notice', source: 'NOTICE', publicName: 'NOTICE', route: '/notice', title: 'Third-party notices', category: 'legal' },
  { id: 'privacy', source: 'PRIVACY.md', publicName: 'PRIVACY.md', route: '/privacy', title: 'Privacy Policy', category: 'legal' },
  { id: 'terms', source: 'TERMS.md', publicName: 'TERMS.md', route: '/terms', title: 'Terms of Service', category: 'legal' },
  { id: 'security', source: 'SECURITY.md', publicName: 'SECURITY.md', route: '/security', title: 'Security policy', category: 'legal' },
  {
    id: 'code-of-conduct',
    source: 'CODE_OF_CONDUCT.md',
    publicName: 'CODE_OF_CONDUCT.md',
    route: '/code-of-conduct',
    title: 'Code of Conduct',
    category: 'legal',
  },
  {
    id: 'contributing',
    source: 'CONTRIBUTING.md',
    publicName: 'CONTRIBUTING.md',
    route: '/contributing',
    title: 'Contributing',
    category: 'community',
  },
];

const ABSENT_CANDIDATES = [
  'PRIVACY.md',
  'TERMS.md',
  'ACCEPTABLE_USE.md',
  'TERMS_OF_SERVICE.md',
  'PRIVACY_POLICY.md',
];

fs.mkdirSync(publicLegal, { recursive: true });
fs.mkdirSync(path.dirname(dataOut), { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const entries = [];

for (const file of FILES) {
  const abs = path.join(repoRoot, file.source);
  if (!fs.existsSync(abs)) {
    throw new Error(`bake-legal: missing required repo file ${file.source} at ${abs}`);
  }
  const buf = fs.readFileSync(abs);
  const text = buf.toString('utf8');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(path.join(publicLegal, file.publicName), buf);
  entries.push({
    id: file.id,
    source: file.source,
    publicPath: `/legal/${file.publicName}`,
    route: file.route,
    title: file.title,
    category: file.category,
    bytes: buf.length,
    sha256,
    firstLine: text.split(/\r?\n/).find((l) => l.trim()) ?? '',
  });
  console.log(
    `bake-legal: ${file.source} -> public/legal/${file.publicName} (${buf.length} bytes, sha256 ${sha256.slice(0, 12)}…)`,
  );
}

const manifest = {
  bakedAt: new Date().toISOString(),
  repository: pkg.repository?.url ?? null,
  packageName: pkg.name ?? null,
  spdxLicense: pkg.license ?? null,
  absentFromRepo: ABSENT_CANDIDATES.filter((name) => !fs.existsSync(path.join(repoRoot, name))),
  files: entries,
};

fs.writeFileSync(dataOut, JSON.stringify(manifest, null, 2) + '\n');
console.log(`bake-legal: wrote ${path.relative(landingRoot, dataOut)}`);
