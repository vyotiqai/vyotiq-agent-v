/**
 * Spend report over recorded run telemetry (read-only; no source edits).
 *
 * Usage:
 *   node scripts/usage-report.mjs                 # every run under the app's userData
 *   node scripts/usage-report.mjs <dir> [dir...]  # a userData dir, a workspace, or one run dir
 *   node scripts/usage-report.mjs --json          # machine-readable, for before/after diffing
 *   node scripts/usage-report.mjs --since 2026-09-01
 *
 * Answers the two questions you cannot answer by staring at a model picker:
 * where the money goes by CALL SITE (turn vs compaction vs …), and by MODEL.
 *
 * Costs are NOT recomputed here. `step_usage` / `aux_usage` already carry
 * `billedCost` (provider-reported) and `estimatedCost` (tokens × published
 * price, from src/shared/pricing/modelPrices.ts) as the app computed them.
 * Re-deriving prices in this script would silently drift from the app.
 *
 * Caveat the output repeats: events.jsonl rotates at 2MB, so a long run's
 * oldest steps may be gone. Archives are stitched in when present; usage.json
 * remains the authoritative per-day total.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Type-stripping a .ts file from a package without "type": "module" emits a
// cosmetic performance notice. Keep the report's output clean; real warnings
// still print.
const defaultWarn = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.code === 'MODULE_TYPELESS_PACKAGE_JSON') return
  for (const listener of defaultWarn) listener(w)
})

const EVENT_ARCHIVE_PREFIX = 'events.archive.'
const REPO_ROOT = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const PRICING_SRC = join(REPO_ROOT, 'src', 'shared', 'pricing', 'modelPrices.ts')

/**
 * Load the app's real pricing table rather than restating it here.
 *
 * `modelPrices.ts` has no imports and uses only erasable syntax, so Node's
 * native type stripping (on by default from Node 22.18 / 23.6) imports it
 * directly. That keeps this script on the exact numbers the app bills with —
 * no second copy of the table to drift, and no new dependency.
 *
 * Returns null on older Node or if the module moves; the report then falls back
 * to the costs already recorded on each event and says so.
 */
async function loadPricing() {
  try {
    const mod = await import(pathToFileURL(PRICING_SRC).href)
    if (typeof mod.resolveModelPrice !== 'function') return null
    if (typeof mod.estimateStepCost !== 'function') return null
    return mod
  } catch {
    return null
  }
}

/**
 * Split one call's cost into its components, mirroring `estimateStepCost`.
 *
 * The prices come from the real table; only the arithmetic is restated, so the
 * caller cross-checks the sum against `estimateStepCost` and reports any
 * divergence instead of quietly printing a wrong breakdown.
 */
function splitCost(ev, resolved) {
  const input = ev.inputTokens ?? 0
  const output = ev.outputTokens ?? 0
  const cached = Math.max(0, ev.cachedInputTokens ?? 0)
  const cacheWrite = Math.max(0, ev.cacheCreationInputTokens ?? 0)
  const { price, longContextThreshold, longContext } = resolved
  const p =
    longContextThreshold !== undefined && longContext !== undefined && input > longContextThreshold
      ? longContext
      : price
  const uncached = ev.inputTokensIncludesCache ? Math.max(0, input - cached) : input
  let outputCost = (output / 1_000_000) * p.output
  if (p.reasoningSeparate) {
    outputCost += (Math.max(0, ev.reasoningTokens ?? 0) / 1_000_000) * (p.reasoning ?? p.output)
  }
  return {
    uncachedInput: (uncached / 1_000_000) * p.input,
    cacheRead: (cached / 1_000_000) * (p.cachedInput ?? p.input),
    cacheWrite: (cacheWrite / 1_000_000) * (p.cacheWrite ?? p.input),
    output: outputCost
  }
}

/** Default userData location per Electron's conventions. */
function defaultUserData() {
  const home = homedir()
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'vyotiq')
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'vyotiq')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'vyotiq')
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listDirs(path) {
  try {
    return readdirSync(path)
      .map((name) => join(path, name))
      .filter(isDir)
  } catch {
    return []
  }
}

/**
 * Resolve an argument to run directories. Accepts a run dir directly, a
 * workspace dir, or a userData root — so you can point it at one session
 * without knowing the layout.
 */
function resolveRunDirs(root) {
  if (existsSync(join(root, 'events.jsonl'))) return [root]
  const out = []
  const sessions = join(root, 'sessions')
  if (isDir(sessions)) {
    for (const dir of listDirs(sessions)) {
      if (existsSync(join(dir, 'events.jsonl'))) out.push(dir)
    }
  }
  const workspaces = join(root, 'workspaces')
  if (isDir(workspaces)) {
    for (const ws of listDirs(workspaces)) out.push(...resolveRunDirs(ws))
  }
  return out
}

/** events.jsonl plus any rotated archives, oldest first. */
function eventFiles(runDir) {
  const archives = (() => {
    try {
      return readdirSync(runDir)
        .filter((n) => n.startsWith(EVENT_ARCHIVE_PREFIX) && n.endsWith('.jsonl'))
        .sort()
        .map((n) => join(runDir, n))
    } catch {
      return []
    }
  })()
  return [...archives, join(runDir, 'events.jsonl')].filter((p) => existsSync(p))
}

function* readEvents(runDir) {
  for (const path of eventFiles(runDir)) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const row = JSON.parse(trimmed)
        if (row?.event) yield { at: row.at, event: row.event }
      } catch {
        // A torn final line during an active run is expected; skip it.
      }
    }
  }
}

function emptyBucket() {
  return {
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    billedCost: 0,
    estimatedCost: 0,
    generationMs: 0
  }
}

function add(bucket, ev) {
  bucket.calls += 1
  bucket.inputTokens += ev.inputTokens ?? 0
  bucket.cachedInputTokens += ev.cachedInputTokens ?? 0
  bucket.outputTokens += ev.outputTokens ?? 0
  bucket.reasoningTokens += ev.reasoningTokens ?? 0
  bucket.billedCost += ev.billedCost ?? 0
  bucket.estimatedCost += ev.estimatedCost ?? 0
  bucket.generationMs += ev.generationMs ?? 0
  return bucket
}

function cost(bucket) {
  // Provider-reported wins; the estimate covers steps the provider didn't bill.
  return bucket.billedCost + bucket.estimatedCost
}

function into(map, key, ev) {
  add(map.get(key) ?? map.set(key, emptyBucket()).get(key), ev)
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const sinceIdx = args.indexOf('--since')
const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null
// Guard the -1 case: `sinceIdx + 1` is 0 when --since is absent, which would
// silently swallow the first positional path.
const sinceValueIdx = sinceIdx >= 0 ? sinceIdx + 1 : -1
const roots = args.filter((a, i) => !a.startsWith('--') && i !== sinceValueIdx)

const searchRoots = roots.length ? roots : [defaultUserData()]
const runDirs = searchRoots.flatMap(resolveRunDirs)

const pricing = await loadPricing()

const bySite = new Map()
const byModel = new Map()
const overall = emptyBucket()
const split = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
let rotated = 0
let stepsWithoutModel = 0
let pricedCalls = 0
let unpriceableCalls = 0
let splitDrift = 0

for (const runDir of runDirs) {
  if (eventFiles(runDir).length > 1) rotated += 1
  for (const { at, event } of readEvents(runDir)) {
    if (event.type !== 'step_usage' && event.type !== 'aux_usage') continue
    if (since && at && at < since) continue
    const site = event.type === 'step_usage' ? 'turn' : (event.site ?? 'aux')
    const model = event.model ? `${event.provider ?? '?'}/${event.model}` : '(unrecorded)'
    if (!event.model) stepsWithoutModel += 1

    // Cost decomposition needs the model, which only events written after
    // per-step attribution landed carry. No model recorded is a different
    // problem from no published price; the notes below distinguish them.
    let resolved = null
    if (pricing && event.model && event.provider) {
      resolved = pricing.resolveModelPrice(event.provider, event.model)
      if (!resolved) unpriceableCalls += 1
    }

    // An event carrying no cost field but naming a priceable model would show
    // $0.00 in the tables while the breakdown below reported real money. Price
    // it here so the two halves of the report agree.
    let priced = event
    if (resolved && event.billedCost == null && event.estimatedCost == null) {
      const est = pricing.estimateStepCost(event, resolved)
      if (est != null) priced = { ...event, estimatedCost: est }
    }

    into(bySite, site, priced)
    into(byModel, model, priced)
    add(overall, priced)

    if (!resolved) continue
    const parts = splitCost(event, resolved)
    const sum = parts.uncachedInput + parts.cacheRead + parts.cacheWrite + parts.output
    const reference = pricing.estimateStepCost(event, resolved)
    if (reference != null && Math.abs(sum - reference) > Math.max(1e-9, reference * 1e-6)) {
      splitDrift += 1
    }
    for (const key of Object.keys(split)) split[key] += parts[key]
    pricedCalls += 1
  }
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        runs: runDirs.length,
        overall,
        bySite: Object.fromEntries(bySite),
        byModel: Object.fromEntries(byModel)
      },
      null,
      2
    )
  )
  process.exit(0)
}

const usd = (n) => (n >= 0.01 || n === 0 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—')
const num = (n) => n.toLocaleString('en-US')

if (!runDirs.length) {
  console.log(`No runs with events.jsonl under: ${searchRoots.join(', ')}`)
  process.exit(0)
}

const total = cost(overall)

console.log(`\nRuns: ${num(runDirs.length)}   Billed calls: ${num(overall.calls)}`)
console.log(`Roots: ${searchRoots.join(', ')}${since ? `   since ${since}` : ''}`)

console.log('\n=== Spend by call site ===')
console.log('site                     calls        in       cached        out      cost     share')
for (const [site, b] of [...bySite].sort((a, c) => cost(c[1]) - cost(a[1]))) {
  console.log(
    `${site.padEnd(22)} ${String(b.calls).padStart(6)} ${num(b.inputTokens).padStart(10)} ` +
      `${num(b.cachedInputTokens).padStart(12)} ${num(b.outputTokens).padStart(10)} ` +
      `${usd(cost(b)).padStart(9)} ${pct(cost(b), total).padStart(8)}`
  )
}

console.log('\n=== Spend by model ===')
console.log('model                                      calls        out      cost     share')
for (const [model, b] of [...byModel].sort((a, c) => cost(c[1]) - cost(a[1]))) {
  console.log(
    `${model.slice(0, 40).padEnd(40)} ${String(b.calls).padStart(6)} ` +
      `${num(b.outputTokens).padStart(10)} ${usd(cost(b)).padStart(9)} ${pct(cost(b), total).padStart(8)}`
  )
}

console.log('\n=== Shape ===')
const allTokens = overall.inputTokens + overall.outputTokens
console.log(`cache hit rate      ${pct(overall.cachedInputTokens, overall.inputTokens)}`)
console.log(
  `output              ${num(overall.outputTokens)} tokens ` +
    `(${pct(overall.outputTokens, allTokens)} of tokens)`
)
console.log(
  `  of which reasoning ${num(overall.reasoningTokens)} ` +
    `(${pct(overall.reasoningTokens, overall.outputTokens)} of output)`
)
console.log(`total cost          ${usd(total)}  (reported ${usd(overall.billedCost)}, est. ${usd(overall.estimatedCost)})`)
if (overall.generationMs > 0 && overall.outputTokens > 0) {
  console.log(
    `generation          ${(overall.generationMs / 1000).toFixed(1)}s ` +
      `→ ${(overall.generationMs / overall.outputTokens).toFixed(1)} ms/output token`
  )
}

if (pricedCalls > 0) {
  const splitTotal = split.uncachedInput + split.cacheRead + split.cacheWrite + split.output
  console.log(`\n=== Where the money goes (${num(pricedCalls)} priced call(s)) ===`)
  for (const [label, key] of [
    ['uncached input', 'uncachedInput'],
    ['cache reads', 'cacheRead'],
    ['cache writes', 'cacheWrite'],
    ['output', 'output']
  ]) {
    if (split[key] === 0 && key === 'cacheWrite') continue
    console.log(
      `${label.padEnd(18)} ${usd(split[key]).padStart(9)}  ${pct(split[key], splitTotal).padStart(7)}`
    )
  }
  console.log(
    `\nOutput is ${pct(split.output, splitTotal)} of spend while being ` +
      `${pct(overall.outputTokens, allTokens)} of tokens.`
  )
}
if (stepsWithoutModel > 0) {
  console.log(
    `\nNote: ${num(stepsWithoutModel)} call(s) predate per-step model attribution and ` +
      `are grouped as "(unrecorded)"; they cannot be decomposed by cost component.`
  )
}
if (!pricing) {
  console.log(
    'Note: could not load src/shared/pricing/modelPrices.ts — cost decomposition skipped. ' +
      'Totals above come from the costs recorded on each event.'
  )
} else if (unpriceableCalls > 0) {
  console.log(
    `Note: ${num(unpriceableCalls)} call(s) named a model with no published price ` +
      `(custom endpoint or unknown id) — tokens counted, cost not decomposed.`
  )
}
if (splitDrift > 0) {
  console.log(
    `WARNING: ${num(splitDrift)} call(s) where this script's cost split disagreed with ` +
      `estimateStepCost — the breakdown above has drifted from the app and needs fixing.`
  )
}
if (rotated > 0) {
  console.log(
    `Note: ${num(rotated)} run(s) had rotated events; archives were stitched in, but ` +
      `usage.json remains the authoritative per-day total.`
  )
}
console.log()
