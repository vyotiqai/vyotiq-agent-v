#!/usr/bin/env node
// Extract monochrome brand SVG path data from the installed @lobehub/icons package.
// Zero dependencies. Node >= 22. Run from landing/: node scripts/extract-provider-icons.mjs
//
// Reads the compiled es/<Brand>/components/Mono.js (memo React component with
// fill="currentColor", fillRule="evenodd", viewBox, a <title> fed from ../style.js
// TITLE, and one or more path d="..." attributes) plus es/<Brand>/style.js TITLE,
// and writes src/data/provider-icons.json in hero display order.
// Exits non-zero if any provider yields zero paths — never emit a fake/empty entry.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const landingRoot = resolve(here, '..');

// @lobehub/icons is a dependency of the workspace root app, not of the landing
// package — resolve from the workspace root so this works when run from landing/.
const require = createRequire(join(landingRoot, '..', 'package.json'));
const pkgEntry = require.resolve('@lobehub/icons');
const pkgEntryDir = dirname(pkgEntry);
// Entry resolves to <pkg>/es/index.js (or fallback <pkg>/index.js); es dir holds per-brand folders.
const esDir = pkgEntryDir.endsWith('es') ? pkgEntryDir : join(pkgEntryDir, 'es');

// Hero display order. Folder name in @lobehub/icons may differ from the hero slug.
const providers = [
  { slug: 'openai', folder: 'OpenAI' },
  { slug: 'anthropic', folder: 'Anthropic' },
  { slug: 'gemini', folder: 'Gemini' },
  { slug: 'ollama', folder: 'Ollama' },
  { slug: 'deepseek', folder: 'DeepSeek' },
  { slug: 'groq', folder: 'Groq' },
  { slug: 'openrouter', folder: 'OpenRouter' },
  { slug: 'xai', folder: 'XAI' },
  { slug: 'mistral', folder: 'Mistral' },
];

const results = [];
const failures = [];

for (const { slug, folder } of providers) {
  const monoPath = join(esDir, folder, 'components', 'Mono.js');
  const stylePath = join(esDir, folder, 'style.js');

  let monoSource;
  let styleSource;
  try {
    monoSource = readFileSync(monoPath, 'utf8');
    styleSource = readFileSync(stylePath, 'utf8');
  } catch (err) {
    failures.push(`${slug}: cannot read package sources (${err.message})`);
    continue;
  }

  const viewBoxMatch = monoSource.match(/viewBox:\s*"([^"]+)"/);
  const titleMatch = styleSource.match(/export\s+var\s+TITLE\s*=\s*(['"])([^'"]+)\1/);
  const paths = [];
  const dRegex = /\bd:\s*"([^"]+)"/g;
  let dMatch;
  while ((dMatch = dRegex.exec(monoSource)) !== null) {
    paths.push(dMatch[1]);
  }

  if (!viewBoxMatch || !titleMatch || paths.length === 0) {
    failures.push(
      `${slug}: extraction failed (viewBox=${viewBoxMatch ? 'ok' : 'missing'}, title=${
        titleMatch ? 'ok' : 'missing'
      }, paths=${paths.length})`,
    );
    continue;
  }

  console.log(`${slug}: ${paths.length} path(s), title="${titleMatch[2]}", viewBox="${viewBoxMatch[1]}"`);
  results.push({ slug, title: titleMatch[2], viewBox: viewBoxMatch[1], paths });
}

// Vendor override: Modal Labs has no @lobehub/icons brand entry. Use their
// official favicon (modal.com/assets/favicon.svg, fetched 2026-09-13) — 7
// pure-geometry paths, no transforms; mono-rendered via currentColor exactly
// like every @lobehub chip.
const modalSvgPath = join(here, '_modal-favicon.svg');
try {
  const modalSvg = readFileSync(modalSvgPath, 'utf8');
  const modalViewBox = modalSvg.match(/viewBox="([^"]+)"/)?.[1];
  const modalPaths = [...modalSvg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
  if (!modalViewBox || modalPaths.length === 0) {
    failures.push('modal: vendor favicon parse failed');
  } else {
    const modalEntry = { slug: 'modal', title: 'Modal', viewBox: modalViewBox, paths: modalPaths };
    const mistralIndex = results.findIndex((r) => r.slug === 'mistral');
    if (mistralIndex === -1) results.push(modalEntry);
    else results.splice(mistralIndex, 0, modalEntry);
    console.log(
      `modal: ${modalPaths.length} path(s), title="Modal", viewBox="${modalViewBox}" (vendor favicon override)`,
    );
  }
} catch (err) {
  failures.push(`modal: cannot read vendor favicon (${err.message})`);
}

if (failures.length > 0) {
  console.error('\nFAILED providers:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

const outPath = join(landingRoot, 'src', 'data', 'provider-icons.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`\nWrote ${results.length} entries to ${outPath}`);
