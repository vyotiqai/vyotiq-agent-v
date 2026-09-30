import { useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, Segmented, cn, pushToast } from '@renderer/lib/ui'
import { ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { Composer } from './Composer'
import { BRANCHES, WORKSPACES } from './data'
import { CheckGlyph, Label, Pill, PopMenu } from './parts'
import { useAgents, type Scope } from './store'

/*
  New task, in the app's anatomy: where it runs is the header (workspace,
  branch, in place or a new worktree); the brief is the box, with done-when
  checks inside it; what the agent will see is its own column on the right,
  each fact a way to where you change it. Under 720px of column the facts go
  under the brief.
*/

const DRAFTS = [
  { t: 'Split billing.ts into modules', m: 'Saved 2d ago', text: 'Split src/billing/billing.ts into invoices, customers and webhooks modules. No behaviour change; the tests must pass unchanged.' },
  { t: 'Add request IDs to every log line', m: 'Saved 5d ago', text: 'Add a request ID to every log line, taken from x-request-id or generated, and return it in the response headers.' }
]

export function NewTask() {
  const { s, d } = useAgents()
  const [where, setWhere] = useState<'here' | 'worktree'>(s.worktreeDefault ? 'worktree' : 'here')
  const [branch, setBranch] = useState<string>('main')
  const [checks, setChecks] = useState<string[]>(['pnpm test passes'])
  const [adding, setAdding] = useState('')
  const workspace = s.scope === 'all' ? 'acme' : s.scope

  const extra = (
    <div className="border-t border-border/60 px-3 py-1.5">
      <ul aria-label="Done when" className="flex flex-col">
        {checks.map((c) => (
          <li key={c} className="group flex h-7 items-center gap-2.5 text-xs">
            <CheckGlyph state="open" />
            <span className="min-w-0 flex-1 truncate text-fg">{c}</span>
            <span className="opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
              <IconButton icon="close" label={`Remove “${c}”`} size="xs" tone="muted" onClick={() => setChecks(checks.filter((x) => x !== c))} />
            </span>
          </li>
        ))}
        <li className="flex h-7 items-center gap-2.5 text-xs">
          <Icon name="plus" size={14} className="w-4 text-tertiary" />
          <input
            aria-label="Add a done-when check"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adding.trim()) {
                e.preventDefault()
                setChecks([...checks, adding.trim()])
                setAdding('')
              }
            }}
            placeholder="Done when… a check it must pass before it can finish"
            className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-tertiary"
          />
        </li>
      </ul>
    </div>
  )

  const start = (text: string): void => {
    d({ type: 'start', brief: text, checks, worktree: where === 'worktree' })
    pushToast('Task started', { state: 'running', detail: where === 'worktree' ? 'In a new worktree' : `In ${workspace}, on ${branch}` })
  }

  return (
    <section aria-label="New task" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2 text-xs text-muted">
        <h1 className="mr-2 text-sm font-semibold text-fg-strong">New task</h1>
        in
        <PopMenu
              label="Workspace"
              items={WORKSPACES.map((w) => ({ id: w.name, label: w.name, checked: w.name === workspace, onSelect: () => d({ type: 'scope', scope: w.name as Scope }) }))}
              trigger={(t, open) => (
            <Pill ref={t.ref} active={open} label={`Workspace: ${workspace}`} aria-expanded={t['aria-expanded']} aria-controls={t['aria-controls']} aria-haspopup={t['aria-haspopup']} onClick={t.onClick}>
              {workspace}
            </Pill>
          )}
        />
        <PopMenu
          label="Branch"
          items={BRANCHES.map((b) => ({ id: b, label: b, checked: b === branch, onSelect: () => setBranch(b) }))}
          trigger={(t, open) => (
            <Pill ref={t.ref} icon="branch" active={open} label={`Branch: ${branch}`} aria-expanded={t['aria-expanded']} aria-controls={t['aria-controls']} aria-haspopup={t['aria-haspopup']} onClick={t.onClick}>
              <span className="font-mono">{branch}</span>
            </Pill>
          )}
        />
        <span className="flex-1" />
        <Segmented
          label="Where it runs"
          value={where}
          onChange={setWhere}
          items={[
            { id: 'here', label: 'In place', title: 'Edits your checkout directly' },
            { id: 'worktree', label: 'New worktree', icon: 'fork', title: 'Its own branch and folder; merge when you are happy' }
          ]}
        />
      </header>

      <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1040px] grid-cols-1 gap-10 px-5 pb-12 pt-6 @[720px]:grid-cols-[minmax(0,1fr)_260px] @[720px]:gap-12 @[720px]:px-8">
          <div className="min-w-0">
          <Composer kind="brief" placeholder="Describe the task — it plans, does the work, and shows you the result" extra={extra} onStart={start} />

          <div className="mt-8">
            <Label className="flex h-7 items-center px-1">Drafts</Label>
            <ul>
              {DRAFTS.map((r) => (
                <li key={r.t}>
                  <button
                    type="button"
                    onClick={() => d({ type: 'draft', text: r.text })}
                    className={cn('-mx-1 flex h-8 w-[calc(100%+8px)] items-center gap-2.5 rounded-md px-2 text-left text-sm vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
                  >
                    <Icon name="note" size={14} className="text-tertiary" />
                    <span className="min-w-0 flex-1 truncate text-fg">{r.t}</span>
                    <span className="text-caption text-tertiary">{r.m}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          </div>

          <aside className="min-w-0 pt-1" aria-label="What the agent will see">
            <h2 className={SECTION_LABEL}>What the agent will see</h2>
            <ul className="mt-2">
              <Fact k="Branch" v={where === 'worktree' ? 'New worktree' : branch} mono={where !== 'worktree'} detail={where === 'worktree' ? `from ${branch} · 3 uncommitted files stay here` : '3 changed · 2 behind'} />
              <Fact k="Rules" v="AGENTS.md" detail="+ 2 rule files in .vyotiq/rules" onClick={() => d({ type: 'view', view: 'extensions' })} />
              <Fact k="Memory" v="12 notes" detail="stack, conventions, deploy, tests…" onClick={() => d({ type: 'view', view: 'settings' })} />
              <Fact k="Index" v="Ready" detail="2,418 files · updated 4 minutes ago" onClick={() => d({ type: 'view', view: 'settings' })} />
              <Fact k="Tools" v="64 built-in · 2 MCP servers" detail="GitHub, Linear" onClick={() => d({ type: 'view', view: 'extensions' })} />
            </ul>
          </aside>
        </div>
      </div>
    </section>
  )
}

/** One fact the task starts from. A fact you can change is a way to where you change it. */
function Fact({ k, v, detail, mono = false, onClick }: { k: string; v: string; detail?: string; mono?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className="block text-caption text-tertiary">{k}</span>
      <span className={cn('mt-0.5 block text-xs text-fg', mono ? 'font-mono' : '')}>{v}</span>
      {detail ? <span className="block text-caption text-tertiary">{detail}</span> : null}
    </>
  )
  return (
    <li>
      {onClick ? (
        <button type="button" onClick={onClick} className={cn('-mx-2 block w-[calc(100%+16px)] rounded-md px-2 py-1.5 text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}>
          {body}
        </button>
      ) : (
        <div className="py-1.5">{body}</div>
      )}
    </li>
  )
}
