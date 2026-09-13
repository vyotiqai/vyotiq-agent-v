// Reports the densest scene-activity windows for BOTH session recordings so
// showcase visuals can be cut from distinct, measured moments.
// Usage: node scripts/detect-windows.mjs
import { spawn } from 'node:child_process';

const FFMPEG =
  'C:\\Users\\ajay\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0-full_build\\bin\\ffmpeg.exe';
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');

const SOURCES = [
  { key: 'rec-185158', src: 'C:\\Users\\ajay\\Documents\\Recording 2026-09-09 185158.mp4' },
  { key: 'rec-185634', src: 'C:\\Users\\ajay\\Documents\\Recording 2026-09-09 185634.mp4' },
];
const WINDOW_S = 6;
const SCENE_GT = 0.01; // low-motion UI capture: scores ~0.001-0.066

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

for (const cfg of SOURCES) {
  const dur = parseFloat(
    (
      await run(FFPROBE, [
        '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', cfg.src,
      ])
    ).stdout.trim(),
  );
  const det = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', cfg.src,
    '-vf', `select='gt(scene,${SCENE_GT})',metadata=print`,
    '-an', '-sn', '-dn', '-f', 'null', '-',
  ]);
  const hits = [];
  for (const line of (det.stdout + det.stderr).split(/\r?\n/)) {
    const pts = line.match(/pts_time:([0-9.]+)/);
    if (pts) {
      hits.push({ t: parseFloat(pts[1]), score: 0 });
      continue;
    }
    const sc = line.match(/lavfi\.scene_score=([0-9.eE+-]+)/);
    if (sc && hits.length) hits[hits.length - 1].score = parseFloat(sc[1]);
  }
  // slide a 6s window; keep top-3 non-overlapping
  const scored = [];
  for (let s = 0; s + WINDOW_S <= dur + 1e-6; s += 0.5) {
    let wscore = 0,
      count = 0;
    for (const h of hits)
      if (h.t >= s && h.t <= s + WINDOW_S) {
        count++;
        wscore += h.score;
      }
    scored.push({ start: s, count, wscore });
  }
  scored.sort((a, b) => b.wscore - a.wscore);
  const picked = [];
  for (const c of scored) {
    if (picked.length >= 3) break;
    if (picked.every((p) => Math.abs(p.start - c.start) >= WINDOW_S)) picked.push(c);
  }
  console.log(`--- ${cfg.key} dur=${dur.toFixed(1)}s hits=${hits.length} ---`);
  for (const p of picked)
    console.log(
      `  ${Math.floor(p.start / 60)}:${String(Math.round(p.start % 60)).padStart(2, '0')} +${WINDOW_S}s hits=${p.count} score=${p.wscore.toFixed(3)}`,
    );
}
