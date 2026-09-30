#!/usr/bin/env node
/**
 * Type errors in tests/ can only go down.
 *
 * `pnpm typecheck` covers src/ only, and tests/ carry a backlog of type errors
 * too large to fix in one go, so CI never looked at them and the count grew
 * unseen. This compares each test config's errors, per file, against
 * scripts/typecheck-tests-baseline.json and fails when any file has more than
 * it did. Fixing errors never fails; `--update` then lowers the baseline.
 *
 * A syntax error fails outright: TypeScript 7 skips semantic checks for the
 * whole program when it meets one, so the count would drop to a handful and
 * hide everything else.
 *
 *   node scripts/typecheck-tests-ratchet.mjs            check
 *   node scripts/typecheck-tests-ratchet.mjs --update   rewrite the baseline
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'scripts', 'typecheck-tests-baseline.json')
export const CONFIGS = ['tsconfig.tests-node.json', 'tsconfig.tests-web.json', 'tsconfig.tests-e2e.json']

/** Per-file error lines from tsc's output. Paths use `/` on every OS. */
export function parseTscErrors(output) {
  const byFile = new Map()
  const syntax = []
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS(\d+):/.exec(line)
    if (!m) continue
    const file = m[1].replace(/\\/g, '/')
    const list = byFile.get(file) ?? []
    list.push(line)
    byFile.set(file, list)
    const code = Number(m[4])
    if (code >= 1000 && code < 2000) syntax.push(line)
  }
  return { byFile, syntax }
}

/** Files whose error count grew, with their current lines. */
export function regressions(byFile, baseline) {
  const out = []
  for (const [file, lines] of byFile) {
    const allowed = baseline[file] ?? 0
    if (lines.length > allowed) out.push({ file, allowed, count: lines.length, lines })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

function runTsc(config) {
  const require = createRequire(import.meta.url)
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsc, '-p', config, '--noEmit', '--pretty', 'false'], { cwd: root })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    // tsc exits non-zero whenever there are errors; the lines are the result.
    child.on('close', () => resolve(output))
  })
}

async function main() {
  const update = process.argv.includes('--update')
  const baseline = update ? {} : JSON.parse(readFileSync(baselinePath, 'utf8'))
  const outputs = await Promise.all(CONFIGS.map((config) => runTsc(config)))
  const next = {}
  let failed = false

  CONFIGS.forEach((config, i) => {
    const { byFile, syntax } = parseTscErrors(outputs[i])
    const total = [...byFile.values()].reduce((n, lines) => n + lines.length, 0)
    next[config] = Object.fromEntries([...byFile].sort(([a], [b]) => a.localeCompare(b)).map(([f, l]) => [f, l.length]))
    if (syntax.length > 0) {
      failed = true
      console.error(`${config}: syntax errors hide every other type error:\n${syntax.join('\n')}`)
      return
    }
    if (update) {
      console.log(`${config}: ${total} errors recorded`)
      return
    }
    const allowed = baseline[config] ?? {}
    const allowedTotal = Object.values(allowed).reduce((n, c) => n + c, 0)
    const grown = regressions(byFile, allowed)
    if (grown.length > 0) {
      failed = true
      console.error(`${config}: ${grown.length} file(s) gained type errors:`)
      for (const g of grown) console.error(`  ${g.file}: ${g.count} (was ${g.allowed})\n    ${g.lines.join('\n    ')}`)
    } else {
      const note = total < allowedTotal ? ` — down from ${allowedTotal}; run with --update to lock that in` : ''
      console.log(`${config}: ${total} errors, none new${note}`)
    }
  })

  if (update && !failed) writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  process.exitCode = failed ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
