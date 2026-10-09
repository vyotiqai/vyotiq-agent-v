import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { announceLive } from '@renderer/lib/a11y/useLiveAnnouncer'
import { Icon, type IconName } from '@renderer/lib/icons'
import { cn, DiffStat, Segmented } from '@renderer/lib/ui'
import { ChartBlock } from '@renderer/lib/ui/ChartBlock'
import { useCopyFeedback } from '@renderer/lib/ui/CodeBlockCopyButton'
import { renderMermaid } from '@renderer/lib/markdown/mermaidRepair'
import { readMermaidThemeVariables } from '@renderer/lib/ui/MermaidDiagram'
import { useDocumentTheme } from '@renderer/lib/ui/useDocumentTheme'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { parseChartSpec } from '@shared/chartSpec'
import { langFromPath, resolveLang, useHighlight, type Token } from './highlight'
import { FileRef } from './refs'
import { FIND_REVEAL_EVENT } from '../../recordFind'

/*
  Fenced code, in one card family: a 32px head that says what the code is
  (a file and its lines, a language, a shell, a diagram) with its actions
  on the right, then the body. The head is there from the fence's first
  line, so nothing below shifts when the code finishes.

  The fence's info string decides the variant:
    ```ts src/auth/session.ts:40-52   code that exists, numbered from line 40
    ```ts src/auth/session.ts         a whole file, or new code for it
    ```diff                           a change, signed + / − in a gutter
    ```sh  /  ```console              commands; Copy leaves out prompts and output
    ```mermaid  /  ```chart           drawn once the fence closes
*/

type Info = { lang: string; path?: string; start?: number; end?: number }

/** `ts src/a.ts:12-30`, `title="src/a.ts"`, or Cursor's `12:30:src/a.ts`. */
export function parseInfo(lang: string, meta: string | undefined): Info {
  const cursor = /^(\d+):(\d+):(.+)$/.exec(lang)
  if (cursor) return { lang: langFromPath(cursor[3]!) ?? '', path: cursor[3], start: Number(cursor[1]), end: Number(cursor[2]) }
  const info: Info = { lang }
  for (const raw of (meta ?? '').match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const word = raw.replace(/^(?:title|file|filename)=/, '').replace(/^"|"$/g, '')
    const m = /^([\w@.~/-]*[/.][\w@.~/-]*?)(?::(\d+)(?:-(\d+))?)?$/.exec(word)
    if (m && !info.path) {
      info.path = m[1]
      if (m[2]) info.start = Number(m[2])
      if (m[3]) info.end = Number(m[3])
    }
  }
  if (!info.lang && info.path) info.lang = langFromPath(info.path) ?? ''
  return info
}

const SHELLS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'ps', 'ps1', 'pwsh', 'cmd', 'bat'])
const NAMES: Record<string, string> = {
  bash: 'Shell',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  dockerfile: 'Dockerfile',
  go: 'Go',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  php: 'PHP',
  powershell: 'PowerShell',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  sql: 'SQL',
  swift: 'Swift',
  toml: 'TOML',
  tsx: 'TSX',
  typescript: 'TypeScript',
  yaml: 'YAML'
}
const displayLang = (lang: string): string => NAMES[resolveLang(lang) ?? ''] ?? (lang || 'Text')

export function CodeFence({ lang, meta, text, streaming }: { lang: string; meta?: string; text: string; streaming: boolean }) {
  const info = parseInfo(lang, meta)
  const l = info.lang.toLowerCase()
  if (l === 'mermaid') return <Diagram source={text} streaming={streaming} />
  if (l === 'chart' && !streaming) {
    const spec = parseChartSpec(text)
    if (spec) return <Chart spec={spec} source={text} />
  }
  if (l === 'diff' || l === 'patch') return <Diff text={text} path={info.path} streaming={streaming} />
  if (SHELLS.has(l)) return <Shell text={text} lang={l} streaming={streaming} />
  return <Code text={text} info={info} streaming={streaming} />
}

/* ─── The card ───────────────────────────────────────────────────────────── */

function Card({ kind, head, actions, children }: { kind: string; head: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <figure className="vy-reply-card group/code" data-kind={kind}>
      <figcaption className={cn('flex h-8 min-w-0 items-center gap-2 border-b pl-3 pr-1 text-caption', BORDER_DIVIDER)}>
        {head}
        <span className="flex-1" />
        {actions ? (
          // Quiet until the card is pointed at or focused — then one row of verbs.
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/code:opacity-100 group-focus-within/code:opacity-100">
            {actions}
          </span>
        ) : null}
      </figcaption>
      {children}
    </figure>
  )
}

function Label({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-tertiary">
      <Icon name={icon} size={12} className="shrink-0" />
      <span className="truncate">{children}</span>
    </span>
  )
}

const ACTION = 'inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-caption text-tertiary hover:bg-surface hover:text-fg focus-visible:vy-focus-ring'

export function CopyAction({ text, label = 'Copy', what = 'code' }: { text: string; label?: string; what?: string }) {
  const { copied, copyError, copy } = useCopyFeedback()
  // The icon and word change for the eye; a screen reader hears the outcome.
  useEffect(() => {
    if (copied) announceLive('Copied')
    else if (copyError) announceLive('Copy failed', 'assertive')
  }, [copied, copyError])
  return (
    <button type="button" className={ACTION} onClick={() => copy(text)} aria-label={copied ? 'Copied' : copyError ? 'Copy failed' : `Copy ${what}`}>
      <Icon name={copied ? 'check' : 'copy'} size={12} />
      {copied ? 'Copied' : copyError ? 'Failed' : label}
    </button>
  )
}

function WrapAction({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    // One name; the pressed state says whether it is on.
    <button type="button" className={ACTION} aria-pressed={on} onClick={() => onChange(!on)} title="Wrap long lines">
      <Icon name="rows" size={12} />
      Wrap
    </button>
  )
}

/* ─── Lines ──────────────────────────────────────────────────────────────── */

const FOLD_AT = 20
const FOLDED_LINES = 14

/** Rows of code. Coloured where the highlighter has caught up; plain text where it has not yet. */
function Lines({
  rows,
  tokens,
  start,
  wrap,
  gutter
}: {
  rows: string[]
  tokens: Token[][] | null
  start?: number
  wrap: boolean
  /** Per-row class and leading sign, for diffs and prompts. */
  gutter?: (i: number) => { sign?: string; signClass?: string; rowClass?: string; textClass?: string }
}) {
  const digits = start ? String(start + rows.length - 1).length : 0
  return (
    <code className={cn('block py-2.5', wrap ? '' : 'w-max min-w-full')}>
      {rows.map((row, i) => {
        const g = gutter?.(i)
        const line = tokens?.[i]
        // A stale colouring (the text moved on) falls back to plain rather than lying.
        const fresh = line && line.map((t) => t.text).join('') === row
        return (
          <span key={i} className={cn('flex min-h-5 pr-4', g?.rowClass, start || g?.sign !== undefined ? '' : 'pl-3')}>
            {start ? (
              <span className="sticky left-0 shrink-0 select-none bg-sunken pl-3 pr-4 text-right text-tertiary" style={{ width: `calc(${digits}ch + 28px)` }} aria-hidden>
                {start + i}
              </span>
            ) : null}
            {g?.sign !== undefined ? (
              <span className={cn('w-7 shrink-0 select-none text-center', g.signClass)} aria-hidden>
                {g.sign}
              </span>
            ) : null}
            <span className={cn(wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre', g?.textClass)}>
              {fresh
                ? line.map((t, k) => (
                    <span key={k} style={t.color || t.italic ? { color: t.color, fontStyle: t.italic ? 'italic' : undefined } : undefined}>
                      {t.text}
                    </span>
                  ))
                : row || ' '}
            </span>
          </span>
        )
      })}
    </code>
  )
}

/** A body that folds past 20 lines, so one long block never buries the answer. */
function Body({ count, wrap, label = 'Code', children }: { count: number; wrap: boolean; label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const folds = count > FOLD_AT
  const folded = folds && !open
  // Find in record opens the fold when its current match is in the cut-off lines.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!folded || !el) return
    const reveal = (): void => setOpen(true)
    el.addEventListener(FIND_REVEAL_EVENT, reveal)
    return () => el.removeEventListener(FIND_REVEAL_EVENT, reveal)
  }, [folded])
  return (
    <>
      <div ref={ref} className="relative" data-find-fold={folded || undefined}>
        <pre
          // A block that scrolls sideways takes focus, so the keyboard can scroll it too.
          tabIndex={wrap ? undefined : 0}
          aria-label={wrap ? undefined : label}
          className={cn(
            'font-mono text-xs leading-5 text-fg focus-visible:vy-focus-ring-inset',
            wrap ? 'overflow-x-hidden' : 'overflow-x-auto',
            folded ? 'overflow-y-hidden' : ''
          )}
          style={folded ? { maxHeight: `${FOLDED_LINES * 20 + 10}px` } : undefined}
        >
          {children}
        </pre>
        {folded ? <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-sunken to-transparent" /> : null}
      </div>
      {folds ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className={cn('flex h-8 w-full items-center gap-1.5 border-t pl-3 text-left text-caption text-muted hover:text-fg-strong focus-visible:vy-focus-ring-inset', BORDER_DIVIDER)}
        >
          <Icon name="chevron" size={11} className={cn('transition-transform', open ? 'rotate-180' : '')} />
          {open ? 'Show less' : `Show all ${count} lines`}
        </button>
      ) : null}
    </>
  )
}

const rowsOf = (text: string): string[] => text.replace(/\n$/, '').split('\n')

/* ─── Variants ───────────────────────────────────────────────────────────── */

function Code({ text, info, streaming }: { text: string; info: Info; streaming: boolean }) {
  const [wrap, setWrap] = useState(false)
  const rows = rowsOf(text)
  const tokens = useHighlight(text, info.lang, streaming)
  const range = info.start ? `${info.start}${info.end && info.end !== info.start ? `–${info.end}` : ''}` : ''
  return (
    <Card
      kind="code"
      head={
        info.path ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <FileRef path={info.path} line={info.start} bare />
            {range ? <span className="shrink-0 font-mono text-tertiary">{`L${range}`}</span> : null}
          </span>
        ) : (
          <Label icon="code">{displayLang(info.lang)}</Label>
        )
      }
      actions={
        <>
          <WrapAction on={wrap} onChange={setWrap} />
          <CopyAction text={text.replace(/\n$/, '')} />
        </>
      }
    >
      <Body count={rows.length} wrap={wrap}>
        <Lines rows={rows} tokens={tokens} start={info.start} wrap={wrap} />
      </Body>
    </Card>
  )
}

/** A prompt: "$ ", "❯ ", "PS C:\> " — and ">" only in cmd, where npm's "> pkg@1.0.0 build" is not one. */
const promptOf = (lang: string): RegExp => (lang === 'cmd' || lang === 'bat' ? /^(?:[A-Z]:[^>]*)?>\s?/ : /^(?:\$|PS(?: [^>]*)?>|❯)(?:\s|$)/)

/** Commands and what they printed. A prompt marks a command; lines without one are output. */
function Shell({ text, lang, streaming }: { text: string; lang: string; streaming: boolean }) {
  const rows = rowsOf(text)
  const PROMPT = promptOf(lang)
  const prompted = rows.some((r) => PROMPT.test(r))
  const isCmd = (r: string): boolean => !prompted || PROMPT.test(r)
  const commands = rows.filter(isCmd).map((r) => (prompted ? r.replace(PROMPT, '') : r))
  // Colour the commands only; output is the machine's, and stays plain.
  const tokens = useHighlight(commands.join('\n'), lang.startsWith('p') ? 'powershell' : 'bash', streaming)
  let k = 0
  const map = rows.map((r) => (isCmd(r) ? k++ : -1))
  const shown = rows.map((r) => (prompted && isCmd(r) ? r.replace(PROMPT, '') : r))
  const ps = lang.startsWith('p') || lang === 'cmd' || lang === 'bat'
  return (
    <Card
      kind="shell"
      head={<Label icon="terminal">{ps ? 'PowerShell' : 'Shell'}</Label>}
      actions={<CopyAction text={commands.join('\n')} label={prompted && commands.length < rows.length ? 'Copy commands' : 'Copy'} what="commands" />}
    >
      <Body count={rows.length} wrap={false}>
        <Lines
          rows={shown}
          tokens={tokens ? map.map((k) => (k >= 0 ? (tokens[k] ?? null) : null)).map((t) => t ?? []) : null}
          wrap={false}
          gutter={
            prompted
              ? (i) => (map[i]! >= 0 ? { sign: ps ? '>' : '$', signClass: 'text-tertiary' } : { sign: '', textClass: 'text-muted' })
              : undefined
          }
        />
      </Body>
    </Card>
  )
}

type DiffRow = { t: '+' | '-' | ' ' | '@' | '\\'; s: string }

function parseDiff(text: string): { rows: DiffRow[]; path?: string } {
  const rows: DiffRow[] = []
  let path: string | undefined
  const lines = rowsOf(text)
  let hunk = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('diff --git ')) hunk = false
    if (/^(?:diff --git|index |new file mode|deleted file mode|similarity index|rename (?:from|to) )/.test(line)) continue
    // Inside a hunk "--- x" is a removed "-- x" (an SQL comment, say), unless a "+++" pairs it as the next file's header.
    const pair = (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) || (line.startsWith('+++ ') && lines[i - 1]?.startsWith('--- '))
    const file = !hunk || pair ? /^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/.exec(line) : null
    if (line.startsWith('@@')) hunk = true
    if (file) {
      if (file[1] !== '/dev/null' && (line.startsWith('+++') || !path)) path = file[1]
      continue
    }
    const t = line[0]
    if (line.startsWith('@@')) rows.push({ t: '@', s: line })
    else if (t === '+' || t === '-' || t === '\\') rows.push({ t, s: line.slice(1) })
    else rows.push({ t: ' ', s: line.startsWith(' ') ? line.slice(1) : line })
  }
  return { rows, path }
}

function Diff({ text, path: given, streaming }: { text: string; path?: string; streaming: boolean }) {
  const { rows, path: found } = useMemo(() => parseDiff(text), [text])
  const path = given ?? found
  const code = rows.filter((r) => r.t !== '@' && r.t !== '\\')
  const tokens = useHighlight(code.map((r) => r.s).join('\n'), path ? (langFromPath(path) ?? '') : '', streaming)
  const add = rows.filter((r) => r.t === '+').length
  const del = rows.filter((r) => r.t === '-').length
  let k = 0
  const at = rows.map((r) => (r.t === '@' || r.t === '\\' ? -1 : k++))
  return (
    <Card
      kind="diff"
      head={
        <span className="flex min-w-0 items-center gap-2">
          {path ? <FileRef path={path} bare /> : <Label icon="diff">Change</Label>}
          <DiffStat add={add} del={del} className="shrink-0" />
        </span>
      }
      actions={<CopyAction text={text.replace(/\n$/, '')} what="diff" />}
    >
      <Body count={rows.length} wrap={false}>
        <Lines
          rows={rows.map((r) => r.s)}
          tokens={tokens ? at.map((i) => (i >= 0 ? (tokens[i] ?? []) : [])) : null}
          wrap={false}
          gutter={(i) => {
            const r = rows[i]!
            if (r.t === '+') return { sign: '+', signClass: 'text-success', rowClass: 'diff-row-add' }
            if (r.t === '-') return { sign: '−', signClass: 'text-danger', rowClass: 'diff-row-del' }
            if (r.t === '@' || r.t === '\\') return { sign: '', textClass: 'text-tertiary' }
            return { sign: '' }
          }}
        />
      </Body>
    </Card>
  )
}

/* ─── Drawn fences ───────────────────────────────────────────────────────── */

type MermaidApi = (typeof import('mermaid'))['default']
let mermaid: Promise<MermaidApi> | null = null
let mermaidWith = ''
let seq = 0

function drawWith(vars: Record<string, string | boolean>): Promise<MermaidApi> {
  mermaid ??= import('mermaid').then((m) => m.default)
  return mermaid.then((m) => {
    const key = JSON.stringify(vars)
    if (key !== mermaidWith) {
      mermaidWith = key
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: 'base',
        // Diagram text at the answer's code size, not mermaid's 16px.
        themeVariables: { ...vars, fontSize: '13px' },
        look: 'classic',
        layout: 'dagre',
        // Compact actors, and no second row of them at the bottom.
        sequence: { width: 112, height: 36, actorMargin: 40, boxMargin: 8, messageMargin: 28, mirrorActors: false, useMaxWidth: true, actorFontSize: 13, messageFontSize: 13, noteFontSize: 13 },
        flowchart: { useMaxWidth: true, padding: 12 }
      })
    }
    return m
  })
}

const DIAGRAMS: [RegExp, string][] = [
  [/^sequenceDiagram/, 'Sequence diagram'],
  [/^(?:flowchart|graph)\b/, 'Flowchart'],
  [/^classDiagram/, 'Class diagram'],
  [/^stateDiagram/, 'State diagram'],
  [/^erDiagram/, 'Entity diagram'],
  [/^gantt/, 'Timeline'],
  [/^gitGraph/, 'Git graph'],
  [/^pie\b/, 'Pie chart'],
  [/^mindmap/, 'Mind map'],
  [/^timeline/, 'Timeline']
]

/** What a diagram shows, in words: a sentence per line of its source, arrows read as "to". */
function describeDiagram(source: string): string {
  return rowsOf(source)
    .slice(1)
    .map((l) =>
      l
        .trim()
        .replace(/%%.*$/, '')
        .replace(/\s*(?:-->>|->>|-->|->|==>|--x|-x|--\)|-\)|---)\s*/g, ' to ')
        .replace(/[[\](){}|"]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('. ')
}

function useSkin(): string {
  const [skin, setSkin] = useState(() => document.documentElement.dataset.skin ?? '')
  useEffect(() => {
    const root = document.documentElement
    const o = new MutationObserver(() => setSkin(root.dataset.skin ?? ''))
    o.observe(root, { attributes: true, attributeFilter: ['data-skin'] })
    return () => o.disconnect()
  }, [])
  return skin
}

/** A mermaid fence: its source while it streams, then the drawing, in the skin's own colours. */
const Diagram = memo(function Diagram({ source, streaming }: { source: string; streaming: boolean }) {
  const theme = useDocumentTheme()
  const skin = useSkin()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const kind = DIAGRAMS.find(([re]) => re.test(source.trimStart()))?.[1] ?? 'Diagram'
  const described = useId()

  useEffect(() => {
    if (streaming) return
    let gone = false
    const id = `vy-reply-mermaid-${seq++}`
    setFailed(false)
    void drawWith(readMermaidThemeVariables(theme === 'dark'))
      // A model's slip (two edges on a line, a bracket in a label) gets one
      // more try put right; the source view still shows what it wrote.
      .then((m) => renderMermaid(m, id, source))
      .then((r) => !gone && setSvg(r.svg))
      .catch(() => {
        if (!gone) {
          setSvg(null)
          setFailed(true)
        }
      })
    return () => {
      gone = true
    }
  }, [source, streaming, theme, skin])

  const drawn = svg && !streaming && !failed
  return (
    <Card
      kind="diagram"
      head={<Label icon="tree">{failed ? `${kind} · could not be drawn` : kind}</Label>}
      actions={
        <>
          {drawn ? (
            <Segmented
              size="xs"
              label="Show"
              value={view}
              onChange={setView}
              items={[
                { id: 'diagram', label: 'Diagram' },
                { id: 'source', label: 'Source' }
              ]}
            />
          ) : null}
          <CopyAction text={source} what="diagram source" />
        </>
      }
    >
      {drawn && view === 'diagram' ? (
        <>
          <div className="vy-reply-diagram overflow-x-auto p-4" role="img" aria-label={kind} aria-describedby={described} dangerouslySetInnerHTML={{ __html: svg }} />
          <span id={described} className="sr-only">
            {describeDiagram(source)}
          </span>
        </>
      ) : (
        <Body count={rowsOf(source).length} wrap={false}>
          <Lines rows={rowsOf(source)} tokens={null} wrap={false} />
        </Body>
      )}
    </Card>
  )
})

function Chart({ spec, source }: { spec: NonNullable<ReturnType<typeof parseChartSpec>>; source: string }) {
  const [view, setView] = useState<'chart' | 'data'>('chart')
  const type = { line: 'Line chart', bar: 'Bar chart', donut: 'Donut chart', sparkline: 'Trend' }[spec.type]
  return (
    <Card
      kind="chart"
      head={<Label icon="chart">{spec.title ? `${type} · ${spec.title}` : type}</Label>}
      actions={
        <>
          <Segmented
            size="xs"
            label="Show"
            value={view}
            onChange={setView}
            items={[
              { id: 'chart', label: 'Chart' },
              { id: 'data', label: 'Data' }
            ]}
          />
          <CopyAction text={source} what="chart data" />
        </>
      }
    >
      {view === 'chart' ? (
        // The app's own chart, drawn in token colours. Its shell (border, copy) is ours here — see styles.css —
        // and so is its title, which the card's head already names.
        <div className="vy-reply-chart px-4 pb-3 pt-2">
          <ChartBlock spec={{ ...spec, title: undefined }} />
        </div>
      ) : (
        <Body count={rowsOf(source).length} wrap={false}>
          <Lines rows={rowsOf(source)} tokens={null} wrap={false} />
        </Body>
      )}
    </Card>
  )
}
