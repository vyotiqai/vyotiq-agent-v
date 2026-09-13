// Encodes the single Agent V hero GIF for the landing product visual.
// Picks the densest-activity 6s window of the 1:10 screen recording via ffmpeg
// scene detection, then encodes one looping GIF with the two-pass palette
// method (palettegen max_colors=256 + sierra2_4a dither) along a quality-first
// size ladder: 1400w@20 -> 1280w@18 -> 1200w@16 -> 1200w@16/5s. Never below
// 1200w — sharpness beats size. Usage: node scripts/encode-media.mjs
// <detect|encode|clean> [window-start]
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import path from 'node:path';

const FFMPEG =
  'C:\\Users\\ajay\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const FFPROBE = path.join(path.dirname(FFMPEG), 'ffprobe.exe');

const SRC = 'C:\\Users\\ajay\\Documents\\Recording 2026-09-09 185634.mp4';
const OUT = 'agentv-hero.gif';
const mediaDir = path.join(import.meta.dirname, '..', 'public', 'media');

// Retired assets (full recordings + stacked highlights — user decisions).
const REMOVE = [
  'agentv-demo.mp4',
  'agentv-walkthrough.mp4',
  'agentv-demo-poster.jpg',
  'agentv-walkthrough-poster.jpg',
  'agentv-highlight-1.gif',
  'agentv-highlight-2.gif',
];

const WINDOW_S = 6;
// Working scene threshold 0.01: low-motion UI capture (scores ~0.001-0.066).
const SCENE_GT = 0.01;
// Quality-first ladder; last rung is the floor (never below 1200w).
const LADDER = [
  { w: 1400, fps: 20, secs: 6 },
  { w: 1280, fps: 18, secs: 6 },
  { w: 1200, fps: 16, secs: 6 },
  { w: 1200, fps: 16, secs: 5 },
];

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

async function detectScenes(src) {
  const { code, stdout, stderr } = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', src,
    '-vf', `select='gt(scene,${SCENE_GT})',metadata=print`,
    '-an', '-sn', '-dn', '-f', 'null', '-',
  ]);
  if (code !== 0) throw new Error(`scene detection failed: ${stderr.slice(-800)}`);
  const hits = [];
  for (const line of (stdout + stderr).split(/\r?\n/)) {
    const pts = line.match(/pts_time:([0-9.]+)/);
    if (pts) {
      hits.push({ t: parseFloat(pts[1]), score: null });
      continue;
    }
    const score = line.match(/lavfi\.scene_score=([0-9.eE+-]+)/);
    if (score && hits.length > 0) hits[hits.length - 1].score = parseFloat(score[1]);
  }
  return hits;
}

function pickWindow(hits, duration) {
  let best = null;
  for (let s = 0; s + WINDOW_S <= duration + 1e-6; s += 0.5) {
    let wscore = 0;
    for (const h of hits) if (h.t >= s && h.t <= s + WINDOW_S) wscore += h.score ?? 0;
    if (!best || wscore > best.wscore) best = { start: s, wscore };
  }
  return best ?? { start: Math.max(0, duration - WINDOW_S), wscore: 0 };
}

function mmss(t) {
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function encode(src, out, { start, w, fps, secs }) {
  const vf =
    `fps=${fps},scale=${w}:-2:flags=lanczos,split[a][b];` +
    `[a]palettegen=max_colors=256[p];` +
    `[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`;
  const { code, stderr } = await run(FFMPEG, [
    '-y', '-hide_banner', '-nostats', '-ss', start.toFixed(3), '-t', String(secs),
    '-i', src, '-vf', vf, '-loop', '0', out,
  ]);
  if (code !== 0) throw new Error(`gif encode failed (${w}w ${fps}fps): ${stderr.slice(-800)}`);
  return (await stat(out)).size;
}

const mode = process.argv[2] ?? 'encode';
const windowOverride = process.argv[3] != null ? parseFloat(process.argv[3]) : null;
const duration = parseFloat(
  (
    await run(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', SRC,
    ])
  ).stdout.trim(),
);
const win = windowOverride != null ? { start: windowOverride, wscore: 0 } : pickWindow(await detectScenes(SRC), duration);
console.log(`source duration=${duration.toFixed(2)}s window=${mmss(win.start)} +${WINDOW_S}s (score-sum ${win.wscore.toFixed(3)})`);

if (mode === 'detect') {
  const hits = await detectScenes(SRC);
  console.log(`hits(${hits.length}): ${hits.slice(0, 60).map((h) => `${h.t.toFixed(2)}s@${h.score?.toFixed(3) ?? '?'}`).join(' ')}${hits.length > 60 ? ' …' : ''}`);
} else if (mode === 'encode') {
  await mkdir(mediaDir, { recursive: true });
  await stat(SRC);
  const out = path.join(mediaDir, OUT);
  for (const step of LADDER) {
    const bytes = await encode(SRC, out, { start: win.start, ...step });
    console.log(`encode ${step.w}w ${step.fps}fps ${step.secs}s -> ${(bytes / 1048576).toFixed(2)}MB`);
  }
  const names = (await readdir(mediaDir)).sort();
  console.log(`media dir: ${names.join(', ')}`);
} else if (mode === 'clean') {
  for (const name of REMOVE) {
    await rm(path.join(mediaDir, name), { force: true });
    console.log(`removed ${name}`);
  }
  const names = (await readdir(mediaDir)).sort();
  console.log(`media dir now: ${names.join(', ') || '(empty)'}`);
} else {
  console.error(`usage: node scripts/encode-media.mjs <detect|encode|clean> [window-start]`);
  process.exit(2);
}
