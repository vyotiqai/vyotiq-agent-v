import { useCallback, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, Checkbox, DiffStat, IconButton, Keys, Segmented, Tooltip, cn } from '@renderer/lib/ui'
import { MENU_SURFACE } from '@renderer/lib/ui/menuStyles'
import { COMMIT_DRAFTS, type FileDiff } from './data'
import { DiffTable, hiddenLines } from './Diff'
import { CheckGlyph, CheckRow, Empty, Path, useDismiss } from './parts'
import { diffsOf, recordOf, taskOf, totals } from './runtime'
import { useActions, useAgents } from './store'

/*
  Review leads with what is still open — a check the task did not meet — and
  only then the files. Keep, Undo and Commit wait until the task stops
  working; each says so rather than hiding. Per file, Keep and Undo are on
  the file's own header.
*/

export function Review() {
  const { s, d } = useAgents()
  const act = useActions()
  const t = taskOf(s, s.agent)
  const diffs = diffsOf(s, t.id)
  const data = recordOf(s, t.id)
  const sum = totals(diffs)
  const [layout, setLayout] = useState<'unified' | 'split'>('unified')
  const [showMet, setShowMet] = useState(false)
  const running = t.state === 'running' || t.state === 'needs'
  const open = data.result ? data.checks.filter((c) => c.state === 'unmet') : []
  const others = data.result ? data.checks.filter((c) => c.state !== 'unmet') : []
  const marks = diffs.map((f) => s.fileMarks[`${t.id}:${f.path}`])
  const kept = marks.filter((m) => m === 'kept').length
  const undone = marks.filter((m) => m === 'undone').length

  if (!diffs.length) {
    return (
      <Empty
        icon="diff"
        title={running ? 'No changes yet' : 'Nothing changed'}
        body={running ? 'Edits show up here as the task makes them, file by file.' : 'This task finished without changing a file.'}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 pl-4 pr-2">
        <span className="text-sm text-fg-strong">
          <span className="font-mono tnum">{diffs.length}</span> {diffs.length === 1 ? 'file' : 'files'}
        </span>
        <DiffStat add={sum.add} del={sum.del} />
        {kept || undone ? (
          <span className="text-caption text-tertiary">
            · {kept ? `${kept} kept` : ''}
            {kept && undone ? ', ' : ''}
            {undone ? `${undone} undone` : ''}
          </span>
        ) : null}
        <span className="flex-1" />
        <Segmented
          label="Diff layout"
          value={layout}
          onChange={setLayout}
          items={[
            { id: 'unified', icon: 'rows', title: 'Unified' },
            { id: 'split', icon: 'columns', title: 'Side by side' }
          ]}
        />
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {data.result ? (
          <div className="border-b border-border/60 px-4 py-3">
            {open.map((c) => (
              <div key={c.text} className="mb-2 rounded-md bg-warning-soft px-3 py-2">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5">
                    <CheckGlyph state="unmet" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-fg-strong">{c.text}</div>
                    <div className="text-caption text-secondary">{c.evidence}</div>
                  </div>
                  <Button size="xs" variant="secondary" onClick={() => d({ type: 'draft', text: `Cover the open check: ${c.text.charAt(0).toLowerCase()}${c.text.slice(1)}.` })}>
                    Ask it to cover this
                  </Button>
                </div>
              </div>
            ))}
            {/* The record lists every check; here the met ones fold to a count so the open one leads. */}
            {others.length ? (
              <button
                type="button"
                aria-expanded={showMet}
                onClick={() => setShowMet(!showMet)}
                className="-mx-1 flex h-6 items-center gap-1.5 rounded-sm px-1 text-caption text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
              >
                <CheckGlyph state="met" />
                {others.length} {others.length === 1 ? 'check' : 'checks'} met
                <Icon name={showMet ? 'chevron' : 'chevronRight'} size={10} />
              </button>
            ) : null}
            <div className="ag-fold" data-open={showMet}>
              <ul className="flex flex-col">
                {others.map((c) => (
                  <CheckRow key={c.text} c={c} dense />
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        {diffs.map((f) => (
          <FileBlock key={f.path} f={f} layout={layout} locked={running || t.state === 'done'} />
        ))}
      </div>

      <Footer
        running={running}
        onUndo={() => act.undoAll(t.id)}
        onKeep={() => act.keepAll(t.id)}
      />
    </div>
  )
}

function Footer({ running, onUndo, onKeep }: { running: boolean; onUndo: () => void; onKeep: () => void }) {
  const { s, d, width } = useAgents()
  const t = taskOf(s, s.agent)
  const o = t.outcome
  const note = 'Settle once it stops working'
  return (
    <div className="relative flex h-12 shrink-0 items-center gap-1.5 border-t border-border px-3">
      {running ? (
        <>
          {/* In the 400px pane the buttons need the room; the note moves into the icon's tooltip. */}
          {width >= 1280 ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-tertiary">
              <Icon name="info" size={13} />
              <span className="truncate">{note}</span>
            </span>
          ) : (
            <span className="flex-1">
              <Tooltip content={note}>
                <button type="button" className="grid size-6 place-items-center rounded-sm text-tertiary focus-visible:vy-focus-ring" aria-label={note}>
                  <Icon name="info" size={13} />
                </button>
              </Tooltip>
            </span>
          )}
          <Button size="sm" variant="ghost" icon="undo" disabled>
            Undo all
          </Button>
          <Button size="sm" variant="secondary" disabled>
            Keep all
          </Button>
          <Button size="sm" variant="primary" icon="commit" disabled>
            Commit
          </Button>
        </>
      ) : o?.kind === 'committed' ? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg">
            <Icon name="commit" size={14} className="text-tertiary" />
            Committed <span className="font-mono">{o.sha}</span> to {t.branch}
          </span>
          <Button size="sm" variant="secondary" icon="pullRequest" onClick={() => d({ type: 'ws', tab: 'pr' })}>
            Pull request
          </Button>
        </>
      ) : o?.kind === 'undone' ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-tertiary">
          <Icon name="undo" size={13} />
          Undone — the files are back as they were
        </span>
      ) : o?.kind === 'kept' ? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg">
            <Icon name="check" size={14} className="text-tertiary" />
            Kept · not committed yet
          </span>
          <CommitButton />
        </>
      ) : (
        <>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" icon="undo" onClick={onUndo}>
            Undo all
          </Button>
          <Button size="sm" variant="secondary" onClick={onKeep}>
            Keep all
          </Button>
          <CommitButton />
        </>
      )}
    </div>
  )
}

function CommitButton() {
  const { s, d } = useAgents()
  return (
    <span data-popover-trigger>
      <Button size="sm" variant="primary" icon="commit" onClick={() => d({ type: 'commit', open: !s.commit })}>
        Commit…
      </Button>
      {s.commit ? <CommitPopover /> : null}
    </span>
  )
}

/** The message is drafted when Review opens; edit it or commit as is. Committing keeps every file. */
function CommitPopover() {
  const { s, d } = useAgents()
  const act = useActions()
  const t = taskOf(s, s.agent)
  const draft = COMMIT_DRAFTS[t.id] ?? { title: t.title, body: '' }
  const [title, setTitle] = useState(draft.title)
  const [body, setBody] = useState(draft.body)
  const [pr, setPr] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => d({ type: 'commit', open: false }), [d])
  useDismiss(ref, true, close)
  const commit = (): void => {
    act.commit(t.id)
    if (pr) d({ type: 'ws', tab: 'pr' })
  }
  return (
    <div ref={ref} role="dialog" aria-label="Commit" className={cn(MENU_SURFACE, 'absolute bottom-[52px] right-3 w-[400px]')}>
      <div className="flex h-10 items-center gap-2 border-b border-border pl-3 pr-2">
        <Icon name="commit" size={15} className="text-tertiary" />
        <span className="flex-1 text-sm font-medium text-fg-strong">
          Commit to <span className="font-mono text-xs">{t.branch}</span>
        </span>
        <span className="text-caption text-tertiary">{diffsOf(s, t.id).length} files</span>
        <IconButton icon="close" label="Close" size="sm" tone="muted" onClick={close} />
      </div>
      <div className="flex flex-col gap-2 p-3">
        <input
          aria-label="Commit title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-8 rounded-md border border-border bg-bg px-2.5 text-sm text-fg-strong outline-none vy-transition focus:border-border-strong focus-visible:vy-focus-ring"
        />
        <textarea
          aria-label="Commit body"
          value={body}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.ctrlKey) (e.preventDefault(), commit())
          }}
          className="resize-none rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-xs leading-[18px] text-fg outline-none vy-transition focus:border-border-strong focus-visible:vy-focus-ring"
        />
        <div className="flex items-center gap-2 text-caption text-tertiary">
          <Icon name="sparkles" size={12} />
          Drafted from the diff and the summary · edit freely
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        <Checkbox checked={pr} onCheckedChange={setPr} label="Then open a draft pull request" />
        <span className="flex-1" />
        <Button size="sm" variant="primary" disabled={!title.trim()} onClick={commit}>
          Commit
        </Button>
        <Keys keys={['Ctrl', '↵']} />
      </div>
    </div>
  )
}

function FileBlock({ f, layout, locked }: { f: FileDiff; layout: 'unified' | 'split'; locked: boolean }) {
  const { s, d } = useAgents()
  const key = `${s.agent}:${f.path}`
  const mark = s.fileMarks[key]
  const [open, setOpen] = useState(true)
  const shownOpen = open && mark !== 'undone'
  const markAs = (m: 'kept' | 'undone'): void => d({ type: 'markFile', agent: s.agent, path: f.path, mark: mark === m ? null : m })
  return (
    <section aria-label={f.path} className="border-b border-border/60">
      <div className="group sticky top-0 z-sticky flex h-9 items-center gap-2 bg-bg pl-2 pr-2">
        <button
          type="button"
          aria-expanded={shownOpen}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs vy-transition hover:bg-surface focus-visible:vy-focus-ring"
        >
          <Icon name={shownOpen ? 'chevron' : 'chevronRight'} size={11} className="shrink-0 text-tertiary" />
          <span
            className={cn(
              'inline-grid size-4 shrink-0 place-items-center rounded-sm font-mono text-2xs font-semibold',
              f.status === 'A' ? 'bg-success-soft text-success' : f.status === 'D' ? 'bg-danger-soft text-danger' : 'bg-surface text-secondary'
            )}
            aria-label={f.status === 'A' ? 'Added' : f.status === 'D' ? 'Deleted' : 'Modified'}
          >
            {f.status}
          </span>
          <Path path={f.path} strong className={cn('flex-1 font-mono text-caption', mark === 'undone' ? 'line-through decoration-tertiary' : '')} />
          {mark ? <span className="shrink-0 text-caption text-tertiary">{mark === 'kept' ? 'Kept' : 'Undone'}</span> : null}
          <DiffStat add={f.add} del={f.del} className="shrink-0" />
        </button>
        <span className={cn('flex items-center gap-0.5 vy-transition', mark ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')}>
          <IconButton icon="undo" label={locked ? 'Available when the task stops working' : mark === 'undone' ? `Bring back ${f.path}` : `Undo ${f.path}`} size="sm" tone="muted" active={mark === 'undone'} disabled={locked} onClick={() => markAs('undone')} />
          <IconButton icon="check" label={locked ? 'Available when the task stops working' : mark === 'kept' ? `Unkeep ${f.path}` : `Keep ${f.path}`} size="sm" tone="muted" active={mark === 'kept'} disabled={locked} onClick={() => markAs('kept')} />
          <IconButton icon="external" label="Open the file" size="sm" tone="muted" onClick={() => d({ type: 'file', path: f.path })} />
        </span>
      </div>
      <div className="ag-fold" data-open={shownOpen}>
        <div>
          <DiffTable lines={f.lines} added={f.status === 'A'} layout={layout} more={hiddenLines(f.lines, f.add, f.del)} />
        </div>
      </div>
    </section>
  )
}
