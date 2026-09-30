import { useState, type KeyboardEvent } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, Segmented, StatusGlyph, StepMarker, cn, pushToast } from '@renderer/lib/ui'
import { ROW_HOVER } from '@renderer/lib/utils/layout'
import { COMMIT_DRAFTS, INSTANCES } from './data'
import { Code } from './Diff'
import { CheckRow, Empty, Label } from './parts'
import { Items, OutLine } from './Record'
import { diffsOf, hasPage, recordOf, taskOf, terminalOf, treeOf } from './runtime'
import { useAgents } from './store'

/* ─── A file ───────────────────────────────────────────────────────────────── */

/** A file as it is now, inside Files, with the task's edits marked on the gutter. Back returns to the tree. */
export function FileView({ path }: { path: string }) {
  const { s, d } = useAgents()
  const diffs = diffsOf(s, s.agent)
  const f = diffs.find((x) => x.path === path)
  const crumbs = path.split('/')
  const rows = f
    ? f.lines.filter((l) => l.t !== '-' && l.t !== '@')
    : ["import { Router } from 'express'", '', '// Unchanged by this task.', 'export const router = Router()'].map((line, i) => ({ t: ' ' as const, b: i + 1, s: line }))
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-caption">
        <IconButton icon="arrowLeft" label="Back to the files" size="sm" tone="muted" onClick={() => d({ type: 'file', path: null })} />
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i ? <Icon name="chevronRight" size={10} className="text-tertiary" /> : null}
            <span className={i === crumbs.length - 1 ? 'text-fg' : 'text-tertiary'}>{c}</span>
          </span>
        ))}
        <span className="flex-1" />
        {f ? <DiffStat add={f.add} del={f.del} /> : <span className="text-tertiary">Unchanged</span>}
        <IconButton icon="external" label="Open in your editor" size="sm" tone="muted" className="ml-1" />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-bg py-2">
        <table className="w-full border-collapse font-mono text-caption leading-[20px]">
          <tbody>
            {rows.map((l, i) => (
              <tr key={i}>
                <td className={cn('w-[3px] select-none', l.t === '+' ? 'bg-success' : '')} aria-label={l.t === '+' ? 'Changed by the task' : undefined} />
                <td className="w-10 select-none pr-3 text-right align-top text-tertiary tnum">{l.b}</td>
                <td className="whitespace-pre pr-4 text-fg">
                  <Code s={l.s} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {f && f.add > rows.filter((r) => r.t === '+').length ? <div className="px-4 pt-2 font-mono text-caption text-tertiary">⋯ {f.add - rows.filter((r) => r.t === '+').length} more lines</div> : null}
      </div>
    </div>
  )
}

/* ─── Terminal ─────────────────────────────────────────────────────────────── */

export function TerminalView() {
  const { s } = useAgents()
  const t = taskOf(s, s.agent)
  const runs = terminalOf(s, t.id)
  if (!runs.length) return <Empty icon="terminal" title="Nothing run yet" body="Every command this task runs lands here, with its output and exit code." />
  return (
    <div className="scroll-thin h-full overflow-y-auto bg-sunken px-4 py-3 font-mono text-caption leading-mono">
      <div className="mb-3 text-tertiary">{t.worktree ? `~/.vyotiq/task-worktrees/${t.workspace}/${t.branch.split('/').pop()}` : `~/code/${t.workspace}`} · what this task ran</div>
      {runs.map((c, i) => (
        <div key={i} className="mb-3">
          <div className="flex items-baseline gap-2">
            <span className="text-tertiary">$</span>
            <span className={cn('min-w-0 flex-1', c.waiting ? 'text-tertiary' : 'text-fg-strong')}>{c.cmd}</span>
            {c.waiting ? (
              <span className="shrink-0 rounded-sm bg-accent-soft px-1 text-accent">waiting for you</span>
            ) : c.live ? (
              <span className="vy-text-live shrink-0">running</span>
            ) : c.time === 'stopped' ? (
              <span className="shrink-0 text-tertiary">stopped</span>
            ) : (
              <span className={cn('shrink-0 tnum', c.exit ? 'text-danger' : 'text-tertiary')}>
                exit {c.exit} · {c.time}
              </span>
            )}
          </div>
          {c.out.map((l, j) => (
            <div key={j} className="min-h-[1lh] whitespace-pre text-secondary">
              <OutLine l={l} />
            </div>
          ))}
          {c.live ? <span className="ag-caret inline-block h-3 w-1.5 translate-y-0.5 bg-fg" /> : null}
        </div>
      ))}
    </div>
  )
}

/* ─── Browser ──────────────────────────────────────────────────────────────── */

export function BrowserView() {
  const { s, d } = useAgents()
  const [vp, setVp] = useState<'800' | '1600'>('800')
  const [hover, setHover] = useState<string | null>('BillingToggle')
  const page = hasPage(s.agent)

  /** While picking, an element is a button: hover or focus outlines it, click or Enter adds it. */
  const pickable = (name: string, tag: string) =>
    s.picking
      ? {
          props: {
            role: 'button' as const,
            tabIndex: 0,
            'aria-label': `Add ${name} to the box`,
            onMouseEnter: () => setHover(name),
            onFocus: () => setHover(name),
            onClick: () => d({ type: 'context', add: { kind: 'element', label: name } }),
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), d({ type: 'context', add: { kind: 'element', label: name } }))
            }
          },
          className: cn('relative cursor-crosshair', hover === name ? 'ag-pick' : 'outline-none'),
          label: hover === name ? `${name} · ${tag}` : null
        }
      : { props: {}, className: 'relative', label: null }
  const toggle = pickable('BillingToggle', 'div')
  const card = pickable('PlanCard', 'article')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <IconButton icon="arrowLeft" label="Back" size="sm" tone="muted" disabled={!page} />
        <IconButton icon="arrowRight" label="Forward" size="sm" tone="muted" disabled />
        <IconButton icon="refresh" label="Reload" size="sm" tone="muted" disabled={!page} />
        <div className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-surface px-2 font-mono text-caption text-fg">
          <Icon name="lock" size={12} className="text-tertiary" />
          {page ? (
            <span className="truncate">
              <span className="text-tertiary">localhost:5173</span>/pricing?billing=annual
            </span>
          ) : (
            <span className="truncate text-tertiary">Enter a URL</span>
          )}
        </div>
        <Segmented label="Viewport" value={vp} onChange={setVp} items={[{ id: '800', label: '800' }, { id: '1600', label: '1600' }]} />
        <IconButton
          icon="target"
          label={s.picking ? 'Stop picking (Esc)' : 'Pick an element to ask about'}
          size="sm"
          tone="muted"
          active={s.picking}
          disabled={!page}
          onClick={() => d({ type: 'pick', on: !s.picking })}
        />
      </div>

      {!page ? (
        <Empty icon="browser" title="No page open" body="The task opens pages here when it checks its work. Enter a URL to open one yourself." />
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-surface p-3">
          <div className="mx-auto overflow-hidden rounded-md border border-border bg-bg shadow-menu" style={{ maxWidth: vp === '800' ? 520 : 760 }}>
            <div className="flex h-10 items-center gap-4 border-b border-border/60 px-5 text-caption text-muted">
              <span className="font-semibold text-fg-strong">Acme</span>
              <span>Docs</span>
              <span className="text-fg-strong">Pricing</span>
              <span>Changelog</span>
              <span className="flex-1" />
              <span className="rounded-sm bg-fg-strong px-2 py-0.5 text-bg">Sign up</span>
            </div>
            <div className="px-6 pb-6 pt-7 text-center">
              <div className="text-title font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">Simple pricing for every API</div>
              <div className="mt-1 text-xs text-muted">Start free. Pay as your traffic grows.</div>

              <div className="mt-9 flex justify-center">
                <div className={toggle.className} {...toggle.props}>
                  {toggle.label ? <PickLabel text={toggle.label} /> : null}
                  <div className="inline-flex items-center gap-2">
                    <div className="inline-flex rounded-full bg-surface p-0.5 text-caption">
                      <span className="rounded-full px-3 py-1 text-muted">Monthly</span>
                      <span className="rounded-full bg-bg px-3 py-1 text-fg-strong shadow-[0_0_0_1px_var(--vy-border)]">Annual</span>
                    </div>
                    <span className="rounded-full bg-success-soft px-2 py-0.5 text-caption font-medium text-success">Save 20%</span>
                  </div>
                </div>
              </div>

              <div className={cn('mt-5 grid gap-2 text-left', vp === '800' ? 'grid-cols-3' : 'grid-cols-3 gap-3')}>
                {[
                  { n: 'Hobby', p: '$0', f: ['10k requests', 'Community support'] },
                  { n: 'Pro', p: '$24', f: ['1M requests', 'Email support', 'Usage alerts'] },
                  { n: 'Scale', p: '$96', f: ['10M requests', 'SLA', 'SSO'] }
                ].map((p) => {
                  const pro = p.n === 'Pro'
                  return (
                    <div key={p.n} className={pro ? card.className : 'relative'} {...(pro ? card.props : {})}>
                      {pro && card.label ? <PickLabel text={card.label} /> : null}
                      <div className={cn('rounded-md border p-3', pro ? 'border-fg-strong' : 'border-border')}>
                        <div className="text-xs font-medium text-fg-strong">{p.n}</div>
                        <div className="mt-1 text-display font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">
                          {p.p}
                          <span className="text-caption font-normal text-muted">/mo</span>
                        </div>
                        <ul className="mt-2 flex flex-col gap-1 text-caption text-secondary">
                          {p.f.map((x) => (
                            <li key={x} className="flex items-center gap-1.5">
                              <Icon name="check" size={11} className="text-tertiary" />
                              {x}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="mt-3 text-center text-caption text-tertiary">
            {s.picking ? 'Click an element (or Tab to it and press Enter) to add it to the box · Esc stops' : `The task checked this page at 800 and 1600px`}
          </div>
        </div>
      )}
    </div>
  )
}

function PickLabel({ text }: { text: string }) {
  return <span className="absolute -top-6 left-0 z-sticky whitespace-nowrap rounded-sm bg-accent px-1.5 py-0.5 font-mono text-2xs text-accent-fg">{text}</span>
}

/* ─── Plan ─────────────────────────────────────────────────────────────────── */

/** The plan as a document: the brief, what done means, and the steps as they stand. */
export function PlanDoc() {
  const { s } = useAgents()
  const t = taskOf(s, s.agent)
  const data = recordOf(s, t.id)
  const billing = t.id === 'plan-billing'
  const answers = s.answers[t.id] ?? []
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pl-4 pr-2 text-caption">
        {billing ? (
          <>
            <span className="text-tertiary">plans</span>
            <Icon name="chevronRight" size={10} className="text-tertiary" />
            <span className="text-fg">usage-billing.md</span>
            <span className="ml-1.5 text-tertiary">· written by the task</span>
          </>
        ) : (
          <span className="text-fg">The plan · todos the task keeps as it works</span>
        )}
        <span className="flex-1" />
        {billing ? (
          <Button size="xs" variant="ghost" icon="edit">
            Edit
          </Button>
        ) : null}
      </div>
      <article className="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <h1 className="text-title font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">{billing ? 'Usage-based billing' : t.title}</h1>
        <p className="mt-2 text-sm leading-[22px] text-secondary">
          {billing ? 'Meter every authenticated request, roll usage up nightly, and report it to Stripe so each invoice carries the month’s overage.' : data.brief}
        </p>

        {billing ? (
          <>
            <h2 className="mt-6 text-heading font-semibold text-fg-strong">Adds</h2>
            <ul className="mt-2 flex flex-col gap-1.5 text-sm text-fg">
              {[
                ['usage_events', 'one row per request: key, route, status, at'],
                ['usage_daily', 'nightly rollup the invoice reads'],
                ['GET /v1/usage', 'the dashboard’s usage page']
              ].map(([k, v]) => (
                <li key={k} className="flex gap-2">
                  <code className="shrink-0 rounded-sm bg-surface px-1 py-px font-mono text-xs text-fg-strong">{k}</code>
                  <span className="text-secondary">{v}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {data.checks.length ? (
          <>
            <h2 className="mt-6 text-heading font-semibold text-fg-strong">Done when</h2>
            <ul className="mt-2">
              {data.checks.map((c) => (
                <CheckRow key={c.text} c={c} dense />
              ))}
            </ul>
          </>
        ) : null}

        <h2 className="mt-6 text-heading font-semibold text-fg-strong">Steps</h2>
        {data.steps.length ? (
          <ol className="mt-2 flex flex-col">
            {data.steps.map((st) => (
              <li key={st.n} className="flex h-8 items-center gap-2.5 border-b border-border/60 text-sm">
                <StepMarker state={st.state} n={st.n} />
                <span className={cn('min-w-0 flex-1 truncate', st.state === 'needs' || st.state === 'running' ? 'font-medium text-fg-strong' : st.state === 'queued' ? 'text-muted' : 'text-fg')}>{st.title}</span>
                {st.time ? <span className="font-mono text-caption tnum text-tertiary">{st.time}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-sm text-tertiary">It writes the steps once it has read enough to plan.</p>
        )}

        {billing ? (
          <>
            <h2 className="mt-6 text-heading font-semibold text-fg-strong">Open questions</h2>
            <ol className="mt-2 flex flex-col gap-1.5 text-sm">
              {['How should overages be billed?', 'Do free keys get a hard cap or a soft one?'].map((q, i) => (
                <li key={q} className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-tertiary">{i + 1}.</span>
                  <span className="min-w-0">
                    <span className="text-fg">{q}</span>
                    {answers[i] ? <span className="block text-xs text-secondary">→ {answers[i]}</span> : null}
                  </span>
                  {!answers[i] && answers.length === i ? <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 text-caption text-accent">asked in the task</span> : null}
                </li>
              ))}
            </ol>
          </>
        ) : null}
      </article>
    </div>
  )
}

/* ─── Files ────────────────────────────────────────────────────────────────── */

export function FilesTree() {
  const { s, d } = useAgents()
  const t = taskOf(s, s.agent)
  const diffs = diffsOf(s, t.id)
  const [toggled, setToggled] = useState<Set<string>>(new Set())
  const [changedOnly, setChangedOnly] = useState(false)
  const [q, setQ] = useState('')
  const nodes = treeOf(t.workspace, diffs, toggled).filter((n) => (changedOnly ? n.dir || n.mark : true)).filter((n) => (q ? n.dir || n.path.toLowerCase().includes(q.toLowerCase()) : true))
  const flip = (path: string, open: boolean): void => {
    const next = new Set(toggled)
    next.delete(path)
    next.delete(`!${path}`)
    next.add(open ? `!${path}` : path)
    setToggled(next)
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-surface px-2 text-xs">
          <Icon name="search" size={13} className="text-tertiary" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files" aria-label="Filter files" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-tertiary" />
        </label>
        <IconButton icon="diff" label={changedOnly ? 'Show every file' : 'Only files this task changed'} size="sm" tone="muted" active={changedOnly} onClick={() => setChangedOnly(!changedOnly)} />
      </div>
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {nodes.map((n) => (
          <li key={n.path}>
            <button
              type="button"
              aria-expanded={n.dir ? n.open : undefined}
              onClick={() => (n.dir ? flip(n.path, n.open) : d({ type: 'file', path: n.path }))}
              className={cn('flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
              style={{ paddingLeft: 8 + n.depth * 14 }}
            >
              <Icon name={n.dir ? (n.open ? 'chevron' : 'chevronRight') : 'file'} size={n.dir ? 10 : 13} className="w-3.5 shrink-0 text-tertiary" />
              <span className={cn('min-w-0 flex-1 truncate', n.mark ? 'text-fg-strong' : n.dir ? 'text-fg' : 'text-secondary')}>{n.name}</span>
              {n.mark ? (
                <span className={cn('font-mono text-caption', n.mark === 'A' ? 'text-success' : n.mark === 'D' ? 'text-danger' : 'text-warning')} aria-label={n.mark === 'A' ? 'added' : n.mark === 'D' ? 'deleted' : 'modified'}>
                  {n.mark}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ─── Pull request ─────────────────────────────────────────────────────────── */

export function PullRequest() {
  const { s } = useAgents()
  const t = taskOf(s, s.agent)
  const [opened, setOpened] = useState(false)
  const draft = COMMIT_DRAFTS[t.id] ?? { title: t.title, body: '' }
  if (t.outcome?.kind !== 'committed') {
    return <Empty icon="pullRequest" title="No pull request yet" body="Commit the kept changes first; then it opens a draft with the summary and the checks as its body." />
  }
  return (
    <div className="scroll-thin h-full overflow-y-auto px-5 py-5">
      <div className="flex items-center gap-2 text-caption text-tertiary">
        <Icon name="pullRequest" size={14} />
        {opened ? (
          <>
            <span className="font-mono text-fg">#482</span> · Draft
          </>
        ) : (
          'Ready to open'
        )}
      </div>
      <h2 className="mt-1 text-heading font-semibold text-fg-strong">{draft.title}</h2>
      <div className="mt-1 flex items-center gap-1.5 font-mono text-caption text-secondary">
        <span className="rounded-sm bg-surface px-1.5 py-px">{t.branch === 'main' ? `vyotiq/${t.id}` : t.branch}</span>
        <Icon name="arrowRight" size={11} className="text-tertiary" />
        <span className="rounded-sm bg-surface px-1.5 py-px">main</span>
        <span className="text-tertiary">· {t.outcome.files} files · {t.outcome.sha}</span>
      </div>
      <p className="mt-3 whitespace-pre-line text-sm leading-[22px] text-fg">{draft.body}</p>

      <Label className="mt-5">Checks</Label>
      <ul className="mt-1.5 flex flex-col gap-1 text-xs">
        {[
          { n: 'typecheck', st: opened ? 'done' : 'queued' },
          { n: 'test (ubuntu, windows, macos)', st: opened ? 'running' : 'queued' }
        ].map((c) => (
          <li key={c.n} className="flex h-6 items-center gap-2">
            <StatusGlyph state={c.st as 'done' | 'running' | 'queued'} size={13} />
            <span className="text-fg">{c.n}</span>
            <span className="text-tertiary">{c.st === 'queued' ? 'starts when it opens' : c.st === 'running' ? 'running' : 'passed'}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex gap-1.5">
        {opened ? (
          <Button size="sm" variant="secondary" icon="external">
            Open on GitHub
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon="pullRequest" onClick={() => (setOpened(true), pushToast('Opened draft pull request #482', { icon: 'pullRequest' }))}>
            Open draft pull request
          </Button>
        )}
      </div>
    </div>
  )
}

/* ─── An instance ──────────────────────────────────────────────────────────── */

/**
 * One instance's own work, in place of its task's record, as the app opens an
 * instance: its own header with the way back, and the next or previous one.
 */
export function InstancePane({ id }: { id: string }) {
  const { s, d } = useAgents()
  const i = INSTANCES.find((x) => x.id === id) ?? INSTANCES[0]
  const n = INSTANCES.indexOf(i) + 1
  const parent = taskOf(s, 'audit-auth')
  return (
    <section aria-label={`Instance ${i.title}`} className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <IconButton icon="arrowLeft" label={`Back to ${parent.title} (Esc)`} size="sm" tone="muted" onClick={() => d({ type: 'instance', id: null })} />
        <button type="button" onClick={() => d({ type: 'instance', id: null })} className="min-w-0 truncate rounded-sm text-sm text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring">
          {parent.title}
        </button>
        <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary" />
        <h1 className="min-w-0 shrink-0 truncate font-mono text-xs font-medium text-fg-strong">{i.title}</h1>
        <span className="flex-1" />
        <span className="shrink-0 text-caption text-tertiary">
          <span className="font-mono tnum">{n}</span> of <span className="font-mono tnum">{INSTANCES.length}</span>
        </span>
        <IconButton icon="chevronLeft" label="Previous instance" size="sm" tone="muted" disabled={n === 1} onClick={() => d({ type: 'instance', id: INSTANCES[n - 2]?.id ?? null })} />
        <IconButton icon="chevronRight" label="Next instance" size="sm" tone="muted" disabled={n === INSTANCES.length} onClick={() => d({ type: 'instance', id: INSTANCES[n]?.id ?? null })} />
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-4 py-5">
          <div className="mb-4 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm text-fg">
            Audit <span className="font-mono text-xs text-fg-strong">{i.title}</span> for handlers that skip requireUser or check the wrong scope. Report; don’t fix.
          </div>
          <Items items={i.items} agent="audit-auth" />
        </div>
      </div>
      <div className="mx-auto flex h-11 w-full max-w-[720px] shrink-0 items-center gap-2 px-4 text-xs text-tertiary">
        <StatusGlyph state={i.state} size={13} />
        <span className="flex-1">Its findings merge into step 2 of the task when all three finish.</span>
        {i.state === 'running' ? (
          <Button size="xs" variant="ghost" icon="stop" onClick={() => pushToast(`Stopped the ${i.title.split('/').pop()} instance`, { state: 'stopped' })}>
            Stop this instance
          </Button>
        ) : null}
      </div>
    </section>
  )
}
