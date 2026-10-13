/**
 * The tray's "mic is on" mark (docs/voice-mode.md §13.8): a filled dot in the
 * icon's bottom-right corner, cut out from what's under it so it reads on any
 * frame of the spinner. Pure and Electron-free, so it is unit-tested; tray.ts
 * applies it to each scale of each frame.
 */

/** The same red as the taskbar's listening badge (scripts/gen-badge-icons.mjs, DANGER). */
const DOT_BGRA = [0x71, 0x71, 0xf8, 0xff] as const

/**
 * A copy of a BGRA bitmap with the dot painted in. Returns the input size
 * unchanged; a bitmap of the wrong length comes back as an untouched copy.
 */
export function paintListeningDot(bgra: Uint8Array, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(bgra)
  if (width <= 0 || height <= 0 || bgra.length !== width * height * 4) return out
  const r = Math.max(2, Math.round(Math.min(width, height) * 0.22))
  const ring = r + Math.max(1, Math.round(r / 3))
  const cx = width - r - 0.5
  const cy = height - r - 0.5
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - (cx + 0.5), y + 0.5 - (cy + 0.5))
      if (d > ring) continue
      const i = (y * width + x) * 4
      if (d <= r) {
        out[i] = DOT_BGRA[0]
        out[i + 1] = DOT_BGRA[1]
        out[i + 2] = DOT_BGRA[2]
        out[i + 3] = DOT_BGRA[3]
      } else {
        // A clear ring between the dot and the icon, so the two never merge.
        out[i] = 0
        out[i + 1] = 0
        out[i + 2] = 0
        out[i + 3] = 0
      }
    }
  }
  return out
}
