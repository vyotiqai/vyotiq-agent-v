// Verifies the built landing embeds the real recording GIFs.
// Usage: node scripts/verify-dist.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const html = await readFile(path.join(import.meta.dirname, '..', 'dist', 'index.html'), 'utf8');

const mediaRefs = (html.match(/media\/agentv/g) ?? []).length;
const gifRefs = (html.match(/agentv-highlight-\d\.gif/g) ?? []).length;
const illustrative = (html.match(/Illustrative UI/g) ?? []).length;
const hasVideo = (html.match(/<video/g) ?? []).length;
const hasMp4 = (html.match(/\.mp4/g) ?? []).length;

console.log(`verify-dist: media/agentv refs=${mediaRefs} (expect >=2)`);
console.log(`verify-dist: agentv-highlight GIF refs=${gifRefs} (expect >=2)`);
console.log(`verify-dist: 'Illustrative UI' occurrences=${illustrative} (expect 0)`);
console.log(`verify-dist: <video> elements=${hasVideo} (expect 0)`);
console.log(`verify-dist: .mp4 references=${hasMp4} (expect 0)`);

if (mediaRefs < 2 || gifRefs < 2 || illustrative !== 0 || hasVideo !== 0 || hasMp4 !== 0) {
  console.error('verify-dist: FAILED');
  process.exit(1);
}
console.log('verify-dist: OK');
