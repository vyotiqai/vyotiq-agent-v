import { z } from 'zod'
import { ChartSpecSchema } from './chartSpec'
import { VIEW_PANELS, VIEW_SOURCE_IDS } from './viewSources'

/**
 * Agent-emitted views — the body of a ```view fence.
 *
 * The model chooses structure; the renderer owns the look. A view is a title
 * and a list of blocks from a closed vocabulary, drawn with the app's own
 * primitives. Its `id` is what lets a later reply reshape it: the renderer
 * keeps blocks and rows whose keys survive and animates only what changed.
 *
 * The fence is model output, so this is a trust boundary like ```chart
 * (`./chartSpec`): every string and list is capped, unknown block types are
 * dropped, and nothing here runs code. A click either sends text back to the
 * agent (`say`, the same channel as typing) or asks the app for one thing
 * from a closed list (`do`, VIEW_DO); a command it would run asks you first.
 */

/** Raw fence-body cap before parsing is attempted. */
export const VIEW_SPEC_MAX_CHARS = 24_000

/*
  Forgiving where a model is predictably loose, strict where it matters.
  A number sent for a text field becomes text, an overlong string is cut
  with an ellipsis, a known synonym ("passed", "error") maps onto the
  vocabulary, and a bad optional field is dropped. A list keeps only the
  items that validate, so one malformed row costs that row, not the view.
  Every cap still holds after all of that.
*/

/** Text, from a string or a number, cut to `max` characters. */
const str = (max: number) =>
  z.preprocess((v) => {
    const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v
    return typeof s === 'string' && s.length > max ? `${s.slice(0, max - 1)}…` : s
  }, z.string().max(max))

/** An optional field a model got wrong is left out rather than failing its block. */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined)

/** Keeps the items that validate, at most `max` of them. */
const list = <T extends z.ZodType>(item: T, max: number, min = 0) =>
  z.preprocess((v) => (Array.isArray(v) ? v.filter((x) => item.safeParse(x).success).slice(0, max) : v), z.array(item).min(min).max(max))

/** One of `values`, accepting a few spellings models use for each (a check's state may come as `true`). */
const oneOf = <const T extends string>(values: readonly [T, ...T[]], aliases: Record<string, NoInfer<T>> = {}) =>
  z.preprocess((v) => {
    if (typeof v === 'boolean') v = String(v)
    if (typeof v !== 'string') return v
    const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_')
    return aliases[k] ?? k
  }, z.enum(values))

/** A non-negative whole number, from 12, "12" or "+12". */
const count = z.preprocess((v) => (typeof v === 'string' ? Number(v.replace(/[^\d.]/g, '')) : v), z.number().int().min(0).max(1e9))

/** 0–1; a percentage (71 or "71%") is read as 0.71. */
const share = z.preprocess((v) => {
  const n = typeof v === 'string' ? Number(v.replace('%', '')) : v
  return typeof n === 'number' && n > 1 && n <= 100 ? n / 100 : n
}, z.number().min(0).max(1))

const key = opt(str(64))
const say = str(300)

const isPlainRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * What a click does in the app itself (VIEW_DO). Read the way models write
 * it: `type` or `kind` for `action`, one `path` where `paths` is meant, and a
 * bare panel name or a URL for those two.
 */
const doAction = z.preprocess(
  (v) => {
    if (!isPlainRecord(v)) return v
    const d: Record<string, unknown> = { ...v }
    d.action ??= d.type ?? d.kind
    if (typeof d.action === 'string') d.action = d.action.trim().toLowerCase()
    if ((d.action === 'stage' || d.action === 'unstage') && !Array.isArray(d.paths) && typeof d.path === 'string') d.paths = [d.path]
    if (d.action === 'panel' && typeof d.panel !== 'string') d.panel = d.tab ?? d.name
    if (d.action === 'link' && typeof d.url !== 'string') d.url = d.href
    if (d.action === 'run' && typeof d.command !== 'string') d.command = d.cmd
    if (d.action === 'commit' && typeof d.sha !== 'string') d.sha = d.hash ?? d.commit
    return d
  },
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('open'), path: str(400) }),
    z.object({ action: z.literal('diff'), path: str(400) }),
    z.object({ action: z.literal('stage'), paths: list(str(400), 50, 1) }),
    z.object({ action: z.literal('unstage'), paths: list(str(400), 50, 1) }),
    z.object({ action: z.literal('commit'), sha: z.string().trim().regex(/^[0-9a-f]{4,64}$/i) }),
    z.object({ action: z.literal('run'), command: z.string().trim().min(1).max(500) }),
    z.object({ action: z.literal('panel'), panel: z.enum(VIEW_PANELS) }),
    // Only a web page: no file:, javascript: or app scheme rides a click.
    z.object({ action: z.literal('link'), url: z.string().max(500).regex(/^https:\/\/[^\s]+$/i) })
  ])
)
export type ViewDo = z.infer<typeof doAction>
/** A table cell: an empty one may come as null, a yes/no as a boolean. */
const cell = z.preprocess((v) => (v == null ? '' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : v), str(80))

const state = oneOf(['queued', 'running', 'needs', 'review', 'done', 'failed', 'stopped', 'paused'], {
  pending: 'queued',
  todo: 'queued',
  waiting: 'needs',
  blocked: 'needs',
  in_progress: 'running',
  success: 'done',
  passed: 'done',
  complete: 'done',
  completed: 'done',
  ok: 'done',
  fail: 'failed',
  error: 'failed',
  cancelled: 'stopped',
  canceled: 'stopped'
})
const checkState = oneOf(['pass', 'fail', 'running', 'pending'], {
  passed: 'pass',
  ok: 'pass',
  success: 'pass',
  done: 'pass',
  green: 'pass',
  true: 'pass',
  failed: 'fail',
  failure: 'fail',
  error: 'fail',
  red: 'fail',
  false: 'fail',
  in_progress: 'running',
  queued: 'pending',
  todo: 'pending',
  skipped: 'pending'
})
const tone = opt(oneOf(['neutral', 'success', 'danger', 'accent'], { good: 'success', positive: 'success', bad: 'danger', error: 'danger', negative: 'danger', warning: 'danger', info: 'accent' }))

const stats = z.object({
  type: z.literal('stats'),
  id: key,
  items: list(
    z.object({
      id: key,
      label: str(40),
      value: str(24),
      hint: opt(str(80)),
      tone,
      say: opt(say),
      do: opt(doAction)
    }),
    6,
    1
  )
})

const rows = z.object({
  type: z.literal('rows'),
  id: key,
  title: opt(str(80)),
  items: list(
    z.object({
      id: key,
      title: str(160),
      /** Muted lead-in: the directory part of a path. */
      lead: opt(str(120)),
      meta: opt(str(100)),
      value: opt(str(32)),
      state: opt(state),
      /** 0–1, drawn as a short bar before the value. */
      share: opt(share),
      diff: opt(z.object({ add: count, del: count })),
      /** Opens this workspace file when clicked. */
      path: opt(str(400)),
      say: opt(say),
      do: opt(doAction)
    }),
    40
  ),
  more: opt(str(80)),
  /** How many there are in all, when the list shows only some: the count beside the title. */
  total: opt(count)
})

const table = z.object({
  type: z.literal('table'),
  id: key,
  title: opt(str(80)),
  columns: list(z.object({ id: str(40), label: str(40), align: opt(oneOf(['start', 'end'], { left: 'start', right: 'end' })) }), 8, 1),
  rows: list(
    z.object({
      id: key,
      cells: z.record(z.string().max(40), cell),
      /** The row the answer points at; the others step back. */
      lead: opt(z.boolean()),
      say: opt(say),
      do: opt(doAction)
    }),
    40
  )
})

const chart = z.object({ type: z.literal('chart'), id: key, spec: ChartSpecSchema })

const checks = z.object({
  type: z.literal('checks'),
  id: key,
  title: opt(str(80)),
  items: list(z.object({ id: key, label: str(160), state: checkState }), 20, 1),
  /** All of them, when only some are listed: the count reads `passed/total`. */
  total: opt(count),
  passed: opt(count),
  more: opt(str(80))
})

const note = z.object({ type: z.literal('note'), id: key, tone: opt(oneOf(['muted', 'success', 'danger'], { info: 'muted', neutral: 'muted', error: 'danger', warning: 'danger' })), text: str(400) })

/** A button: words for the agent (`say`), or something the app does (`do`). */
const action = z
  .object({ label: str(40), say: opt(say), do: opt(doAction), primary: opt(z.boolean()) })
  .refine((a) => a.say !== undefined || a.do !== undefined)

const actions = z.object({
  type: z.literal('actions'),
  id: key,
  title: opt(str(160)),
  body: opt(str(400)),
  actions: list(action, 4, 1)
})

/** Filled by the app from one of its own reads (VIEW_SOURCES) and kept current. */
const live = z.object({
  type: z.literal('live'),
  id: key,
  source: oneOf(VIEW_SOURCE_IDS, {
    changes: 'git.changes',
    uncommitted: 'git.changes',
    git_changes: 'git.changes',
    git_status: 'git.changes',
    branch: 'git.branch',
    git_branch: 'git.branch',
    commits: 'git.commits',
    git_commits: 'git.commits',
    git_log: 'git.commits',
    checks: 'pr.checks',
    ci: 'pr.checks',
    pr_checks: 'pr.checks',
    task_changes: 'task.changes',
    task_files: 'task.changes',
    spend: 'usage.spend',
    usage: 'usage.spend',
    usage_spend: 'usage.spend',
    usage_days: 'usage.days'
  }),
  title: opt(str(80)),
  limit: opt(z.coerce.number().int().min(1).max(40))
})

const field = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'),
    id: str(40),
    label: str(80),
    options: list(z.object({ id: str(40), label: str(80), hint: opt(str(160)) }), 6, 2),
    value: opt(str(40))
  }),
  z.object({ kind: z.literal('switch'), id: str(40), label: str(80), hint: opt(str(160)), value: opt(z.boolean()) }),
  z.object({ kind: z.literal('text'), id: str(40), label: str(80), placeholder: opt(str(120)), value: opt(str(400)) })
])

const form = z.object({
  type: z.literal('form'),
  id: key,
  title: opt(str(160)),
  fields: list(field, 6, 1),
  /** `{fieldId}` is replaced by what was chosen or typed. */
  submit: z.object({ label: str(40), say })
})

export const ViewBlockSchema = z.discriminatedUnion('type', [stats, rows, table, chart, checks, note, actions, form, live])

export type ViewBlock = z.infer<typeof ViewBlockSchema>
export type ViewBlockOf<T extends ViewBlock['type']> = Extract<ViewBlock, { type: T }>

export type ViewSpec = {
  id: string
  title: string
  subtitle?: string
  blocks: ViewBlock[]
}

const head = z.object({ id: str(64).pipe(z.string().min(1)), title: str(80).pipe(z.string().min(1)), subtitle: opt(str(160)) })

/** The list each block streams item by item, so a partial block can still show what has arrived. */
const ITEM_LISTS = ['items', 'rows', 'fields', 'actions'] as const

/** Set by `parsePartialJson` on every object the stream has not closed yet. */
export const OPEN_MARK = '\u0000open'

const isOpen = (v: unknown): boolean => Boolean(v && typeof v === 'object' && OPEN_MARK in (v as object))

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** A table row's own fields; every other key of a plain-object row is a cell. */
const ROW_KEYS = new Set(['id', 'lead', 'say', 'do', OPEN_MARK])

/**
 * The shapes models reach for instead of the documented one, mapped onto it:
 * a rows/stats/checks list called `rows`, table rows as arrays or as plain
 * objects keyed by column, columns as bare labels, a chart's fields on the
 * block itself, an action as a bare string, a note's text called `body`.
 */
export function normalizeBlock(raw: Record<string, unknown>): Record<string, unknown> {
  const b: Record<string, unknown> = { ...raw }
  if (typeof b.type === 'string') b.type = b.type.trim().toLowerCase()
  const t = b.type
  if ((t === 'rows' || t === 'stats' || t === 'checks' || t === 'list') && !Array.isArray(b.items) && Array.isArray(b.rows)) b.items = b.rows
  if (t === 'list') b.type = 'rows'
  if (t === 'table') {
    if (!Array.isArray(b.rows) && Array.isArray(b.items)) b.rows = b.items
    // No columns: the first finished row's own keys name them.
    if (!Array.isArray(b.columns) && Array.isArray(b.rows)) {
      const first = b.rows.find((r) => isRecord(r) && !isOpen(r))
      if (isRecord(first)) b.columns = Object.keys(isRecord(first.cells) ? first.cells : first).filter((k) => !ROW_KEYS.has(k))
    }
    if (Array.isArray(b.columns))
      b.columns = b.columns.map((c) => {
        if (typeof c === 'string' || typeof c === 'number') return { id: String(c), label: String(c) }
        // A column named by only one of id and label is named by it twice.
        if (isRecord(c)) return { ...c, id: c.id ?? c.key ?? c.label, label: c.label ?? c.title ?? c.id ?? c.key }
        return c
      })
    const cols = Array.isArray(b.columns) ? b.columns.filter(isRecord).map((c) => String(c.id ?? '')) : []
    // Cells keyed by a column's label instead of its id.
    const byLabel = new Map(Array.isArray(b.columns) ? b.columns.filter(isRecord).map((c) => [String(c.label ?? '').toLowerCase(), String(c.id ?? '')]) : [])
    const rekey = (cells: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(cells).map(([k, v]) => [cols.includes(k) ? k : (byLabel.get(k.toLowerCase()) ?? k), v]))
    if (Array.isArray(b.rows))
      b.rows = b.rows.map((r) => {
        if (Array.isArray(r)) return { cells: Object.fromEntries(cols.map((c, i) => [c, r[i] ?? ''])) }
        if (!isRecord(r) || isOpen(r)) return r
        if (isRecord(r.cells)) return { ...r, cells: rekey(r.cells) }
        const { id, lead, say: s, do: d, ...cells } = r
        return { id, lead, say: s, do: d, cells: rekey(cells) }
      })
  }
  if (t === 'chart' && !isRecord(b.spec) && Array.isArray(b.values)) {
    const kind = b.chart ?? b.chartType ?? b.kind ?? b.variant ?? 'bar'
    b.spec = { type: kind, title: b.title, labels: b.labels, values: b.values }
  }
  // A block that names a source is that source's live block, whatever type it was given.
  if (t !== 'live' && typeof b.source === 'string' && !Array.isArray(b.items) && !Array.isArray(b.rows)) b.type = 'live'
  if (t === 'actions' && !Array.isArray(b.actions) && Array.isArray(b.items)) b.actions = b.items
  if (t === 'actions' && Array.isArray(b.actions)) b.actions = b.actions.map((a) => (typeof a === 'string' ? { label: a, say: a } : a))
  if (t === 'note' && typeof b.text !== 'string') b.text = b.body ?? b.content ?? b.message
  return b
}

/**
 * One block. Finished: it must validate whole. Still being written: only its
 * finished items show — a row appears when its object closes, never with a
 * number half typed — and only once at least one has.
 */
function readBlock(raw: unknown): ViewBlock | null {
  if (!isRecord(raw)) return null
  const obj = normalizeBlock(raw)
  if (!isOpen(raw)) {
    const whole = ViewBlockSchema.safeParse(obj)
    return whole.success ? whole.data : null
  }
  const name = ITEM_LISTS.find((k) => Array.isArray(obj[k]))
  if (!name) return null
  const done = (obj[name] as unknown[]).filter((item) => !isOpen(item))
  if (done.length === 0) return null
  const partial = ViewBlockSchema.safeParse({ ...obj, [name]: done })
  return partial.success ? partial.data : null
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)

function readView(json: unknown, partial: boolean): ViewSpec | null {
  if (!isRecord(json)) return null
  // A view with a title but no id still draws; the title names it.
  const id = json.id ?? (typeof json.title === 'string' ? slug(json.title) : undefined)
  const h = head.safeParse({ ...json, id })
  if (!h.success) return null
  const rawBlocks = Array.isArray(json.blocks) ? json.blocks.slice(0, 12) : []
  const blocks = rawBlocks.map(readBlock).filter((b): b is ViewBlock => b !== null)
  if (!partial && blocks.length === 0) return null
  return { ...h.data, blocks }
}

/**
 * Trailing commas (`[1, 2,]`) are the one syntax slip models make often
 * enough to forgive. Only commas outside strings are touched.
 */
export function dropTrailingCommas(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') continue
    }
    out += c
  }
  return out
}

/**
 * What a forgiving parse left out of a view's raw JSON: whole blocks that did
 * not validate, and items (rows, stats, checks, fields, buttons) dropped from
 * blocks that did — so a model can be told, not left to think they showed.
 */
export function viewDrops(json: unknown): { blocks: number; items: number } {
  if (!isRecord(json) || !Array.isArray(json.blocks)) return { blocks: 0, items: 0 }
  let blocks = Math.max(0, json.blocks.length - 12)
  let items = 0
  for (const raw of json.blocks.slice(0, 12)) {
    const obj = isRecord(raw) ? normalizeBlock(raw) : null
    const parsed = obj ? ViewBlockSchema.safeParse(obj) : null
    if (!obj || !parsed?.success) {
      blocks += 1
      continue
    }
    for (const name of ITEM_LISTS) {
      const sent = obj[name]
      const kept = (parsed.data as Record<string, unknown>)[name]
      if (Array.isArray(sent) && Array.isArray(kept)) items += Math.max(0, sent.length - kept.length)
    }
  }
  return { blocks, items }
}

/** Parse a closed ```view fence; null means "render as a plain code block". */
export function parseViewSpec(raw: string): ViewSpec | null {
  const text = raw.trim()
  if (text.length === 0 || text.length > VIEW_SPEC_MAX_CHARS) return null
  try {
    return readView(JSON.parse(dropTrailingCommas(text)), false)
  } catch {
    return null
  }
}

/**
 * Parse a fence that is still streaming. Only what is finished is drawn:
 * every closed block, and the closed rows of the block being written. Null
 * until the id and the whole title have arrived.
 */
export function parseViewSpecStreaming(raw: string): ViewSpec | null {
  const text = raw.trim()
  if (text.length === 0 || text.length > VIEW_SPEC_MAX_CHARS) return null
  const json = parsePartialJson(dropTrailingCommas(text))
  return json === undefined ? null : readView(json, true)
}

/**
 * Best-effort JSON for a prefix of a JSON document. Only finished values
 * survive: a string still being written, a number whose digits may not all
 * be here, and a key with no value are cut back to the last safe point.
 * Every object the cut leaves open is closed with an `OPEN_MARK` key, so a
 * reader can tell a finished row from one still arriving.
 * Returns undefined when no prefix parses.
 */
export function parsePartialJson(text: string): unknown {
  const stack: string[] = []
  let inString = false
  let escaped = false
  // Safe cut points: just after a container opens or closes, after a string,
  // or just before a comma (the value before it is whole).
  const cuts: Array<{ at: number; open: string }> = []
  const mark = (at: number): void => {
    cuts.push({ at, open: stack.join('') })
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') {
        inString = false
        mark(i + 1)
      }
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') {
      stack.push(c)
      mark(i + 1)
    } else if (c === '}' || c === ']') {
      stack.pop()
      mark(i + 1)
    } else if (c === ',') mark(i)
  }
  if (!inString && stack.length === 0) {
    const whole = tryParse(text)
    if (whole !== undefined) return whole
  }
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 40; k--, tries++) {
    const { at, open } = cuts[k]!
    const prefix = text.slice(0, at)
    let tail = ''
    // Innermost first. An object right after its "{" needs no comma before the mark.
    let fresh = /[{[]\s*$/.test(prefix)
    for (const o of [...open].reverse()) {
      // JSON-escaped, so it parses to OPEN_MARK.
      tail += o === '{' ? `${fresh ? '' : ','}"\\u0000open":1}` : ']'
      fresh = false
    }
    const attempt = tryParse(prefix + tail)
    if (attempt !== undefined) return attempt
  }
  return undefined
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
