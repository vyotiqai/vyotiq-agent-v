/**
 * Copy Material Icon Theme SVGs into the renderer public folder for runtime URLs.
 * Only icons referenced by generateManifest({ activeIconPack: 'react' }) plus
 * default file/folder icons. Clone SVGs are copied as `{id}.svg` to match
 * iconUrlForId(). Runs on postinstall and before dev/build.
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateManifest } from 'material-icon-theme'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function resolveMaterialIconsDir() {
  const require = createRequire(import.meta.url)
  const pkgJson = require.resolve('material-icon-theme/package.json')
  return path.join(path.dirname(pkgJson), 'icons')
}

const DEFAULT_IDS = ['file', 'folder', 'folder-open', 'folder-root', 'folder-root-open']
const MANIFEST_MAPS = [
  'fileExtensions',
  'fileNames',
  'languageIds',
  'folderNames',
  'folderNamesExpanded',
  'rootFolderNames',
  'rootFolderNamesExpanded'
]

const srcDir = resolveMaterialIconsDir()
const destDir = path.join(root, 'src/renderer/public/file-icons')

function collectReferencedIds() {
  const manifest = generateManifest({ activeIconPack: 'react' })
  const ids = new Set(DEFAULT_IDS)
  for (const key of ['file', 'folder', 'folderExpanded', 'rootFolder', 'rootFolderExpanded']) {
    const value = manifest[key]
    if (typeof value === 'string' && value) ids.add(value)
  }
  for (const mapName of MANIFEST_MAPS) {
    const map = manifest[mapName]
    if (!map) continue
    for (const value of Object.values(map)) {
      if (typeof value === 'string' && value) ids.add(value)
    }
  }
  return ids
}

function resolveSourceSvg(id, svgNames) {
  if (svgNames.has(`${id}.svg`)) return `${id}.svg`
  if (svgNames.has(`${id}.clone.svg`)) return `${id}.clone.svg`
  return null
}

async function sync() {
  await mkdir(destDir, { recursive: true })

  const entries = await readdir(srcDir, { withFileTypes: true })
  const svgNames = new Set(
    entries.filter((e) => e.isFile() && e.name.endsWith('.svg')).map((e) => e.name)
  )

  const referenced = collectReferencedIds()
  const destNames = new Set()
  let copied = 0
  let skipped = 0

  for (const id of referenced) {
    const sourceName = resolveSourceSvg(id, svgNames)
    if (!sourceName) {
      skipped++
      continue
    }
    const destName = `${id}.svg`
    destNames.add(destName)
    await copyFile(path.join(srcDir, sourceName), path.join(destDir, destName))
    copied++
  }

  const destEntries = await readdir(destDir, { withFileTypes: true })
  let removed = 0
  for (const entry of destEntries) {
    if (entry.isFile() && entry.name.endsWith('.svg') && !destNames.has(entry.name)) {
      await rm(path.join(destDir, entry.name))
      removed++
    }
  }

  console.log(
    `[sync-file-icons] synced ${copied} icons (${skipped} missing, ${removed} stale removed) -> ${path.relative(root, destDir)}`
  )
}

sync().catch((err) => {
  console.error('[sync-file-icons] failed:', err)
  process.exit(1)
})
