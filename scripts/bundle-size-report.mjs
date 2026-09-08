#!/usr/bin/env node
/**
 * bundle-size-report.mjs — repeatable installer size audit.
 *
 * Measures what electron-builder actually packs for a `--dir` target:
 *   1. resources/app.asar      (packed JS/wasm of out/ + node_modules)
 *   2. resources/app.asar.unpacked (native addons + ORT shared libs)
 *   3. the win-unpacked tree    (electron dist + locales + resources)
 *
 * Bytes inside the asar are attributed per top-level node_modules package by
 * parsing the asar header (no extra dependency needed). Unpacked bytes are
 * attributed by walking the directory tree.
 *
 * Also reports a per-OS platform-native breakdown (onnxruntime-node backends,
 * @node-llama-cpp prebuilds, node-pty prebuilds) so mac/linux installer sizes
 * can be estimated config-only from the win measurement.
 *
 * Usage:
 *   node scripts/bundle-size-report.mjs [--unpacked dist-package/win-unpacked]
 *                                       [--asar resources/app.asar]
 *                                       [--json]
 */
import fs from 'fs'
import path from 'path'

const MB = 1024 * 1024
const fmt = (b) => (b >= MB ? (b / MB).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

// --- asar header parsing (chromium pickle) ---------------------------------
function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    // Pickle layout: [0..3] payload size, [4..7] header pickle size,
    // [8..11] header object size, [12..15] JSON string length, JSON at 16.
    const sizeBuf = Buffer.alloc(16)
    fs.readSync(fd, sizeBuf, 0, 16, 0)
    const jsonLen = sizeBuf.readUInt32LE(12)
    const headerBuf = Buffer.alloc(jsonLen)
    fs.readSync(fd, headerBuf, 0, jsonLen, 16)
    return JSON.parse(headerBuf.toString('utf8'))
  } finally {
    fs.closeSync(fd)
  }
}

function walkAsar(node, prefix, visit) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walkAsar(child, prefix ? prefix + '/' + name : name, visit)
    }
  } else if (typeof node.size === 'number') {
    visit(prefix, node.size, node.unpacked === true)
  }
}

// --- disk walking -----------------------------------------------------------
function walkDisk(dir, visit, base = dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkDisk(full, visit, base)
    else if (ent.isFile()) {
      let size = 0
      try {
        size = fs.statSync(full).size // statSync follows symlinks/junctions
      } catch {
        /* unreadable -> count as 0 */
      }
      visit(path.relative(base, full).split(path.sep).join('/'), size)
    }
  }
}

// --- attribution ------------------------------------------------------------
const PKG_RE = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//
function pkgOf(relPath) {
  const m = PKG_RE.exec(relPath)
  return m ? m[1] : '(app/out)'
}

function add(map, key, bytes) {
  map.set(key, (map.get(key) ?? 0) + bytes)
}

// --- main -------------------------------------------------------------------
const argv = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const unpackedDir = argOf('--unpacked', 'dist-package/win-unpacked')
const asarPath = argOf('--asar', path.join(unpackedDir, 'resources', 'app.asar'))
const asJson = argv.includes('--json')

const asarPkg = new Map()
const unpackedPkg = new Map()
const platformNative = new Map() // per-OS platform-native files (see classify)

// Per-OS native subdirs whose bytes only load on one OS/platform. Used for the
// mac/linux config-only estimate: those bytes are excluded by electron-builder
// per-OS `files` globs, so they must not be charged to the other OSes.
function classifyNative(rel) {
  let m
  if ((m = /^app\.asar\.unpacked\/.*node_modules\/onnxruntime-node\/bin\/napi-v6\/([^/]+)\//.exec(rel)))
    return ['onnxruntime-node', m[1]]
  if ((m = /^app\.asar\.unpacked\/.*node_modules\/(@node-llama-cpp\/[^/]+)\//.exec(rel))) {
    const pkg = m[1]
    return ['@node-llama-cpp', pkg]
  }
  if ((m = /^app\.asar\.unpacked\/.*node_modules\/node-pty\/(prebuilds\/[^/]+)\//.exec(rel)))
    return ['node-pty', m[1]]
  return null
}

let asarTotal = 0
let asarUnpackedFlagged = 0
{
  const index = readAsarIndex(asarPath)
  walkAsar(index, '', (rel, size, isUnpacked) => {
    asarTotal += size
    if (isUnpacked) {
      asarUnpackedFlagged += size
      return // bytes live on disk under app.asar.unpacked, not in the archive
    }
    add(asarPkg, pkgOf(rel), size)
  })
}

let unpackedTotal = 0
walkDisk(path.join(unpackedDir, 'resources', 'app.asar.unpacked'), (rel, size) => {
  unpackedTotal += size
  // rel is already relative to app.asar.unpacked root (node_modules/...).
  add(unpackedPkg, pkgOf(rel), size)
  const nat = classifyNative('app.asar.unpacked/' + rel)
  if (nat) add(platformNative, nat[0] + ' :: ' + nat[1], size)
})

let dirTotal = 0
const dirTop = new Map()
walkDisk(unpackedDir, (rel, size) => {
  dirTotal += size
  const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel
  add(dirTop, top, size)
})

const merged = new Map()
for (const [k, v] of asarPkg) add(merged, k, v)
for (const [k, v] of unpackedPkg) add(merged, k, v)
const rows = [...merged.entries()].sort((a, b) => b[1] - a[1])
const nodeModulesTotal = rows
  .filter(([k]) => k !== '(app/out)')
  .reduce((s, [, v]) => s + v, 0)
const appOutTotal = merged.get('(app/out)') ?? 0

if (asJson) {
  console.log(
    JSON.stringify(
      {
        unpackedDir,
        appAsarFileBytes: fs.statSync(asarPath).size,
        asarPackedBytes: asarTotal - asarUnpackedFlagged,
        asarUnpackedBytes: unpackedTotal,
        appOutBytes: appOutTotal,
        nodeModulesBytes: nodeModulesTotal,
        dirTotalBytes: dirTotal,
        perPackage: Object.fromEntries(rows),
        platformNative: Object.fromEntries([...platformNative.entries()].sort((a, b) => b[1] - a[1])),
        dirTopLevel: Object.fromEntries([...dirTop.entries()].sort((a, b) => b[1] - a[1]))
      },
      null,
      2
    )
  )
  process.exit(0)
}

console.log(`# bundle size report — ${unpackedDir}`)
console.log(`app.asar (file on disk):      ${fmt(fs.statSync(asarPath).size)}`)
console.log(`asar packed content:          ${fmt(asarTotal - asarUnpackedFlagged)} (unpacked-flagged ${fmt(asarUnpackedFlagged)} lives in app.asar.unpacked)`)
console.log(`app.asar.unpacked (disk):     ${fmt(unpackedTotal)}`)
console.log(`  ├ app/out (bundled src):    ${fmt(appOutTotal)}`)
console.log(`  └ node_modules packed:      ${fmt(nodeModulesTotal)}`)
console.log(`win-unpacked total (disk):    ${fmt(dirTotal)}`)
console.log('')
console.log('Per top-level node_modules package (asar packed + unpacked native):')
for (const [pkg, bytes] of rows) console.log(`  ${fmt(bytes).padStart(10)}  ${pkg}`)
console.log('')
console.log('Per-OS platform-native bytes (unpacked):')
for (const [k, v] of [...platformNative.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${fmt(v).padStart(10)}  ${k}`)
console.log('')
console.log('win-unpacked top-level:')
for (const [k, v] of [...dirTop.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${fmt(v).padStart(10)}  ${k}`)
