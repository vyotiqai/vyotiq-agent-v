import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import png2icons from 'png2icons'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/*
 * Both sources come from the one generated kit (scripts/
 * generate-precision-mono-brand.mjs). They used to come from a second,
 * hand-kept kit whose hexagon was a different radius, so the packaged app
 * shipped a visibly different mark from the website.
 *
 * Two sources, not one: Windows and Linux want the full-bleed square, macOS
 * wants the squircle inset on its own icon grid.
 */
const brandDir = path.join(root, 'resources', 'branding', 'precision-mono')
const sourcePath = path.join(brandDir, 'vyotiq-app-icon.png')
const macosSourcePath = path.join(brandDir, 'vyotiq-app-icon-macos.png')
const runtimePath = path.join(root, 'resources', 'icon.png')
const outputPath = path.join(root, 'resources', 'icon.ico')
const icnsPath = path.join(root, 'resources', 'icon.icns')
const sizes = [16, 24, 32, 48, 64, 128, 256]

function iconDirectory(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(images.length * 16)
  let offset = header.length + entries.length
  images.forEach(({ size, data }, index) => {
    const entryOffset = index * 16
    entries.writeUInt8(size === 256 ? 0 : size, entryOffset)
    entries.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
    entries.writeUInt8(0, entryOffset + 2)
    entries.writeUInt8(0, entryOffset + 3)
    entries.writeUInt16LE(1, entryOffset + 4)
    entries.writeUInt16LE(32, entryOffset + 6)
    entries.writeUInt32LE(data.length, entryOffset + 8)
    entries.writeUInt32LE(offset, entryOffset + 12)
    offset += data.length
  })

  return Buffer.concat([header, entries, ...images.map(({ data }) => data)])
}

for (const required of [sourcePath, macosSourcePath]) {
  if (!existsSync(required)) {
    throw new Error(
      `[sync-app-icon] missing ${path.relative(root, required)} — run \`pnpm sync:brand\` first`
    )
  }
}
const source = await readFile(sourcePath)
const macosSource = await readFile(macosSourcePath)
const runtimePng = await sharp(source).resize(1024, 1024, { fit: 'cover' }).png().toBuffer()
// Generate every format BEFORE writing any: a png2icons failure must not leave
// a half-updated icon set (stale .icns beside a fresh .png/.ico).
const images = await Promise.all(
  sizes.map(async (size) => ({
    size,
    data: await sharp(source).resize(size, size, { fit: 'cover' }).png().toBuffer()
  }))
)
// icns is built from the macOS master, so the Dock gets the squircle rather
// than a square; png2icons emits the full Retina mip ladder (16-1024) so
// electron-builder packs the macOS bundle deterministically. `contain` on a
// transparent canvas keeps the margin the icon grid asks for.
const macosPng = await sharp(macosSource)
  .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer()
const icns = png2icons.createICNS(macosPng, png2icons.BILINEAR, 0)
if (!icns) throw new Error('[sync-app-icon] png2icons produced no ICNS output')

await writeFile(runtimePath, runtimePng)
await writeFile(outputPath, iconDirectory(images))
await writeFile(icnsPath, icns)
console.log(
  `[sync-app-icon] synced the precision-mono kit to ${path.relative(root, runtimePath)}, ${path.relative(root, outputPath)}, and ${path.relative(root, icnsPath)}`
)
