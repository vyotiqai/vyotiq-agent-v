/**
 * Remove `out/renderer` so the next build writes a pristine tree.
 *
 * Builds keep `emptyOutDir: false` (see electron.vite.config.ts) so a rebuild
 * cannot delete the chunks a running app is still lazily importing. That leaves
 * superseded chunks on disk, which is right for a dev loop and wrong for a
 * package: electron-builder copies `out/**` wholesale, so every `pack:*` script
 * runs this first.
 */
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(repoRoot, 'out', 'renderer')

rmSync(target, { recursive: true, force: true })
console.log(`[vyotiq] cleaned ${target}`)
