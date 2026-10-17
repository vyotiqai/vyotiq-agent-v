import { copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { app } from 'electron'

/**
 * Home's backdrop picture. The file the person picks is copied into
 * `<userData>/appearance/home-backdrop.<ext>` and read back from there only:
 * settings records that a picture exists (a stamp), never where it came
 * from, so no settings write can point a read at another file — the risk
 * `customCssPathAllowed` has to guard against for Custom CSS.
 */

const BASE = 'home-backdrop'

/** A wallpaper-sized photo fits; anything bigger costs more IPC than it is worth. */
export const HOME_BACKDROP_MAX_BYTES = 8 * 1024 * 1024

export const HOME_BACKDROP_MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp'
}

export const HOME_BACKDROP_EXTENSIONS = Object.keys(HOME_BACKDROP_MIME)

function dir(): string {
  return join(app.getPath('userData'), 'appearance')
}

function extOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

async function existing(): Promise<string[]> {
  try {
    return (await readdir(dir())).filter((name) => name.startsWith(`${BASE}.`))
  } catch {
    return []
  }
}

/** Copy a picked picture in as the backdrop, replacing the last one. Returns the stamp to save. */
export async function adoptHomeBackdrop(source: string): Promise<{ ok: true; stamp: string } | { ok: false; error: string }> {
  const ext = extOf(source)
  if (!HOME_BACKDROP_MIME[ext]) return { ok: false, error: 'Choose a PNG, JPEG, WebP, AVIF, GIF or BMP picture' }
  const info = await stat(source)
  if (!info.isFile()) return { ok: false, error: 'That is not a file' }
  if (info.size > HOME_BACKDROP_MAX_BYTES) return { ok: false, error: 'The picture is larger than 8 MB' }
  await mkdir(dir(), { recursive: true })
  // Copy first, then drop the others: a copy that fails leaves the last picture in place.
  const name = `${BASE}.${ext}`
  await copyFile(source, join(dir(), name))
  await clearHomeBackdrop(name)
  return { ok: true, stamp: new Date().toISOString() }
}

/** The copied picture as a data URL, or null when there is none. */
export async function readHomeBackdrop(): Promise<string | null> {
  const name = (await existing())[0]
  if (!name) return null
  const mime = HOME_BACKDROP_MIME[extOf(name)]
  if (!mime) return null
  const bytes = await readFile(join(dir(), name))
  if (bytes.byteLength > HOME_BACKDROP_MAX_BYTES) return null
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** Remove the copied picture: a removed backdrop leaves no copy of the person's photo behind. */
export async function clearHomeBackdrop(keep?: string): Promise<void> {
  for (const name of await existing()) {
    if (name === keep) continue
    try {
      await unlink(join(dir(), name))
    } catch {
      // Already gone or held open: the next adopt overwrites by name anyway.
    }
  }
}
