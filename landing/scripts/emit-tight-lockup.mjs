// Tight-crops the landing's nav lockup: the canonical generated
// vyotiq-lockup-white.svg carries ~80px internal padding on every side, which
// renders the mark + wordmark at barely half the box at nav height.
// Restores the landing copy from the canonical asset, then rasterizes it at 4x
// with @resvg/resvg (the generator's own dependency) and scans the alpha
// channel for exact ink bounds — pixel-accurate, immune to relative path
// commands — and rewrites the copy's viewBox/width/height to fit.
// Usage: node landing/scripts/emit-tight-lockup.mjs
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const canonical = 'resources/branding/precision-mono/vyotiq-lockup-white.svg';
const target = 'landing/public/brand/vyotiq-lockup-white.svg';

const pristine = readFileSync(canonical, 'utf8');
copyFileSync(canonical, target); // discard any previous viewBox experiments

const vb = /viewBox="([\d.\s-]+)"/.exec(pristine)[1].trim().split(/\s+/).map(Number);
const vbW = vb[2];

const SCALE = 4; // 0.25 svg-unit ink precision
const img = new Resvg(pristine, { fitTo: { mode: 'width', value: Math.round(vbW * SCALE) } }).render();
const px = img.pixels;
if (!px) {
  console.error('resvg returned no pixel buffer');
  process.exit(1);
}
const rw = img.width;
const rh = img.height;
let minX = rw,
  minY = rh,
  maxX = -1,
  maxY = -1;
for (let y = 0; y < rh; y++) {
  for (let x = 0; x < rw; x++) {
    if (px[(y * rw + x) * 4 + 3] > 8) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
}
if (maxX < 0) {
  console.error('no ink found');
  process.exit(1);
}
const u = (v) => +(v / SCALE).toFixed(3);
const inkW = u(maxX - minX);
const inkH = u(maxY - minY);
const box = [+(u(minX) - 0.5).toFixed(3), +(u(minY) - 0.5).toFixed(3), +(inkW + 1).toFixed(3), +(inkH + 1).toFixed(3)];
console.log(`ink: ${inkW}x${inkH} svg-units at (${u(minX)}, ${u(minY)})`);
console.log(`tight: viewBox="${box.join(' ')}" (w=${box[2]} h=${box[3]}, aspect ${(box[2] / box[3]).toFixed(3)})`);
writeFileSync(
  target,
  pristine
    .replace(/viewBox="[^"]+"/, `viewBox="${box.join(' ')}"`)
    .replace(/width="[^"]+"/, `width="${box[2]}"`)
    .replace(/height="[^"]+"/, `height="${box[3]}"`),
);
console.log('written', target);
