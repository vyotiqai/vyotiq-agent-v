import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, CheckMark, IconButton, Keys, RadioList, Segmented, Switch, cn, pushToast } from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { EFFORTS, MODELS, type Effort } from './data'
import { Label, Pill, PopMenu } from './parts'
import { SKINS, useAgents, type Skin, type Theme } from './store'
import { LIST_W } from './TaskList'

/*
  Settings borrows the task list's column for its index, as the app does, and
  reads as one scrolling column of rows. A value left at its default is quiet;
  a changed one is in ink with Reset beside it, so what you changed is what
  you see first. The header names the section you are in.
*/

const SECTIONS: { id: string; label: string; icon: IconName; words: string }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'circleHalf', words: 'skin theme dark light text size font' },
  { id: 'agent', label: 'Agent', icon: 'robot', words: 'approvals ask worktree instances allow commands sound' },
  { id: 'models', label: 'Models and keys', icon: 'model', words: 'model effort provider api key anthropic openai ollama' },
  { id: 'tools', label: 'Tools and MCP', icon: 'mcp', words: 'mcp servers tools extensions skills' },
  { id: 'memory', label: 'Rules and memory', icon: 'rules', words: 'rules memory notes agents.md' },
  { id: 'index', label: 'Code index', icon: 'database', words: 'index search embeddings pause exclude' },
  { id: 'voice', label: 'Voice', icon: 'mic', words: 'dictation voice microphone language' },
  { id: 'keys', label: 'Shortcuts', icon: 'keyboard', words: 'shortcuts keys keyboard' },
  { id: 'about', label: 'About', icon: 'info', words: 'version update about' }
]

const SHORTCUTS: [string[], string][] = [
  [['Ctrl', 'K'], 'Search tasks, files and commands'],
  [['Ctrl', 'N'], 'New task'],
  [['Ctrl', 'I'], 'Show or hide the side pane'],
  [['Ctrl', 'Shift', 'I'], 'Side pane full width'],
  [['Ctrl', 'B'], 'Show or hide the task list'],
  [['Alt', '1–6'], 'Review, Files, Terminal, Browser, Plan, Pull request'],
  [['Alt', '↑ ↓'], 'Previous or next task'],
  [['Ctrl', '.'], 'Stop the task'],
  [['Shift', '↵'], 'Steer now, while it runs'],
  [['Shift', 'Tab'], 'Agent or Ask'],
  [['1–3'], 'Answer a question'],
  [['Ctrl', ','], 'Settings']
]

export function SettingsNav({ active, onGo }: { active: string; onGo: (id: string) => void }) {
  const { d } = useAgents()
  const [q, setQ] = useState('')
  const shown = SECTIONS.filter((x) => !q || `${x.label} ${x.words}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <nav aria-label="Settings" className="flex h-full min-h-0 flex-col bg-chrome" style={{ width: LIST_W }}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <button
          type="button"
          onClick={() => d({ type: 'view', view: 'agent' })}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm text-secondary vy-transition hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring"
        >
          <Icon name="arrowLeft" size={14} />
          Back to tasks
        </button>
      </div>
      <label className="mx-2 mt-2 flex h-8 items-center gap-1.5 rounded-md px-2 text-xs vy-transition hover:bg-surface focus-within:bg-surface">
        <Icon name="search" size={13} className="text-tertiary" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings" aria-label="Search settings" className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-tertiary" />
      </label>
      <ul className="flex flex-col gap-px px-2 pt-1">
        {shown.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              aria-current={x.id === active || undefined}
              onClick={() => onGo(x.id)}
              className={cn('flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm vy-transition focus-visible:vy-focus-ring', x.id === active ? SELECTED : cn(ROW_HOVER, 'text-secondary'))}
            >
              <Icon name={x.icon} size={15} className="text-tertiary" />
              {x.label}
            </button>
          </li>
        ))}
        {!shown.length ? <li className="px-2 py-3 text-xs text-tertiary">No setting matches “{q}”.</li> : null}
      </ul>
    </nav>
  )
}

export function useSettingsScroll() {
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('appearance')
  const go = (id: string): void => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' })
    setActive(id)
  }
  const onScroll = (): void => {
    const box = scroller.current
    if (!box) return
    const sections = Array.from(box.querySelectorAll<HTMLElement>('[data-settings-section]'))
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 4
    const current = atEnd ? sections[sections.length - 1] : sections.filter((s) => s.offsetTop - 24 <= box.scrollTop).pop()
    if (current?.dataset.settingsSection) setActive(current.dataset.settingsSection)
  }
  return { scroller, active, go, onScroll }
}

export function Settings({
  skin,
  theme,
  onSkin,
  onTheme,
  scroller,
  active,
  onScroll
}: {
  skin: Skin
  theme: Theme
  onSkin: (s: Skin) => void
  onTheme: (t: Theme) => void
  scroller: RefObject<HTMLDivElement | null>
  active: string
  onScroll: () => void
}) {
  const { s, d } = useAgents()
  const [themeChoice, setThemeChoice] = useState<'system' | Theme>('system')
  const [scale, setScale] = useState<'small' | 'default' | 'large'>('default')
  const [approval, setApproval] = useState<'ask' | 'risky' | 'never'>('risky')
  const [instances, setInstances] = useState(16)
  const [sound, setSound] = useState(false)
  const [effort, setEffort] = useState<Effort>(s.effort)
  const [paused, setPaused] = useState(false)
  const [voice, setVoice] = useState<'fast' | 'accurate'>('accurate')
  const [allowed, setAllowed] = useState(['pnpm test', 'pnpm tsc', 'git status'])
  const always = Object.entries(s.allowed).filter(([, v]) => v === 'always').map(([id]) => (id === 'migrate-sessions' ? 'pnpm db:migrate' : id))
  const title = SECTIONS.find((x) => x.id === active)?.label ?? 'Settings'

  return (
    <section aria-label="Settings" className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2">
        <h1 className="flex items-center gap-1.5 text-sm">
          <span className="text-tertiary">Settings</span>
          <Icon name="chevronRight" size={11} className="text-tertiary" />
          <span className="font-semibold text-fg-strong">{title}</span>
        </h1>
      </header>
      <div ref={scroller} onScroll={onScroll} className="scroll-thin relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-6 pb-[40vh] pt-5">
          <Section id="appearance" title="Appearance">
            <Label className="mb-3 mt-1">Skin</Label>
            <div role="radiogroup" aria-label="Skin" className="grid grid-cols-5 gap-3 pb-4">
              {SKINS.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={k === skin} onClick={() => onSkin(k)} className="group flex flex-col gap-1.5 rounded-lg text-left focus-visible:vy-focus-ring">
                  <SkinPreview skin={k} theme={theme} on={k === skin} />
                  <span className={cn('flex items-center gap-1.5 px-0.5 text-xs capitalize', k === skin ? 'text-fg-strong' : 'text-muted')}>
                    {k === skin ? <CheckMark on /> : null}
                    {k}
                    {k === 'native' ? <span className="normal-case text-tertiary">· default</span> : null}
                  </span>
                </button>
              ))}
            </div>
            <Row label="Theme" hint="System follows Windows" changed={themeChoice !== 'system'} onReset={() => (setThemeChoice('system'), onTheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))}>
              <Segmented
                label="Theme"
                value={themeChoice}
                onChange={(t) => {
                  setThemeChoice(t)
                  onTheme(t === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t)
                }}
                items={[
                  { id: 'system', label: 'System', icon: 'monitor' },
                  { id: 'light', label: 'Light', icon: 'sun' },
                  { id: 'dark', label: 'Dark', icon: 'moon' }
                ]}
              />
            </Row>
            <Row label="Text size" changed={scale !== 'default'} onReset={() => setScale('default')}>
              <Segmented
                label="Text size"
                value={scale}
                onChange={setScale}
                items={[
                  { id: 'small', label: 'Small' },
                  { id: 'default', label: 'Default' },
                  { id: 'large', label: 'Large' }
                ]}
              />
            </Row>
          </Section>

          <Section id="agent" title="Agent">
            <Row label="Approvals" hint="What it asks before doing" changed={approval !== 'risky'} onReset={() => setApproval('risky')} stack>
              <RadioList
                label="Approvals"
                value={approval}
                onChange={setApproval}
                className="mt-2"
                choices={[
                  { value: 'ask', label: 'Ask before every command and edit', description: 'Slowest; you see everything' },
                  { value: 'risky', label: 'Ask before risky commands', description: 'Deletes, deploys, database changes, network writes' },
                  { value: 'never', label: 'Never ask', description: 'Unattended. MCP tools still ask first' }
                ]}
              />
            </Row>
            <Row label="Always allowed" hint="Commands that never ask, in this workspace" changed={false} stack>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {[...always, ...allowed].map((c) => (
                  <li key={c} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card pl-2 pr-0.5 font-mono text-caption text-fg">
                    {c}
                    <IconButton icon="close" label={`Stop always allowing ${c}`} size="xs" tone="muted" onClick={() => setAllowed(allowed.filter((x) => x !== c))} />
                  </li>
                ))}
              </ul>
            </Row>
            <Row label="New tasks start in a worktree" hint="Your checkout stays untouched until you merge" changed={s.worktreeDefault} onReset={() => d({ type: 'worktreeDefault', on: false })}>
              <Switch checked={s.worktreeDefault} onCheckedChange={(on) => d({ type: 'worktreeDefault', on })} label="New tasks start in a worktree" />
            </Row>
            <Row label="Instances at once" hint="Helpers one task may run in parallel" changed={instances !== 16} onReset={() => setInstances(16)}>
              <span className="inline-flex h-7 items-center rounded-md border border-border">
                <IconButton icon="minus" label="Fewer" size="sm" tone="muted" disabled={instances <= 1} onClick={() => setInstances(instances - 1)} />
                <span className={cn('w-8 text-center font-mono text-xs tnum', instances !== 16 ? 'text-fg-strong' : 'text-muted')}>{instances}</span>
                <IconButton icon="plus" label="More" size="sm" tone="muted" disabled={instances >= 32} onClick={() => setInstances(instances + 1)} />
              </span>
            </Row>
            <Row label="Sound when a task needs you" changed={sound} onReset={() => setSound(false)}>
              <Switch checked={sound} onCheckedChange={setSound} label="Sound when a task needs you" />
            </Row>
          </Section>

          <Section id="models" title="Models and keys">
            <Row label="Default model" hint="New tasks start with it; the box can change it per task" changed={s.model !== 'Opus 5.5'} onReset={() => d({ type: 'model', model: 'Opus 5.5' })}>
              <PopMenu
                label="Default model"
                align="end"
                items={MODELS.map((m) => ({ id: m.id, label: m.name, checked: s.model === m.name, onSelect: () => d({ type: 'model', model: m.name }) }))}
                trigger={(t, open) => (
                  <Pill ref={t.ref} tone="filled" active={open} aria-expanded={t['aria-expanded']} aria-controls={t['aria-controls']} aria-haspopup={t['aria-haspopup']} onClick={t.onClick}>
                    {s.model}
                  </Pill>
                )}
              />
            </Row>
            <Row label="Default effort" changed={effort !== 'High'} onReset={() => setEffort('High')}>
              <Segmented label="Default effort" value={effort} onChange={setEffort} items={EFFORTS.map((e) => ({ id: e, label: e }))} />
            </Row>
            <Row label="Providers" changed={false} stack>
              <ul className="mt-2 border-t border-border/60">
                {[
                  { name: 'Anthropic', state: 'Key ending 7f2a', ok: true },
                  { name: 'OpenAI', state: 'Key ending 91c0', ok: true },
                  { name: 'Google', state: 'No key', ok: false },
                  { name: 'Ollama', state: 'Running locally · 3 models', ok: true }
                ].map((p) => (
                  <li key={p.name} className="flex h-10 items-center gap-2.5 border-b border-border/60 text-sm">
                    <span className={cn('size-1.5 rounded-full', p.ok ? 'bg-success' : 'bg-border-strong')} aria-hidden />
                    <span className="w-24 text-fg">{p.name}</span>
                    <span className={cn('flex-1 text-xs', p.ok ? 'text-muted' : 'text-tertiary')}>{p.state}</span>
                    <Button size="xs" variant={p.ok ? 'ghost' : 'secondary'}>
                      {p.ok ? 'Change' : 'Add key'}
                    </Button>
                  </li>
                ))}
              </ul>
            </Row>
          </Section>

          <Section id="tools" title="Tools and MCP">
            <Row label="MCP servers" hint="GitHub and Linear connected · Sentry needs sign-in · Postgres off" changed={false}>
              <Button size="xs" variant="secondary" trailingIcon="arrowRight" onClick={() => d({ type: 'view', view: 'extensions' })}>
                Extensions
              </Button>
            </Row>
            <Row label="MCP tools ask first" hint="Even when commands don’t" changed={false}>
              <Switch checked onCheckedChange={() => undefined} label="MCP tools ask first" />
            </Row>
          </Section>

          <Section id="memory" title="Rules and memory">
            <Row label="Rules" hint="AGENTS.md and 2 files in .vyotiq/rules" changed={false}>
              <Button size="xs" variant="ghost" trailingIcon="arrowRight" onClick={() => d({ type: 'view', view: 'extensions' })}>
                3 rules
              </Button>
            </Row>
            <Row label="Memory" hint="12 notes earlier tasks wrote about this repo" changed={false}>
              <Button size="xs" variant="danger" onClick={() => pushToast('Memory cleared for acme', { icon: 'memory' })}>
                Clear…
              </Button>
            </Row>
          </Section>

          <Section id="index" title="Code index">
            <Row label="Index" hint="2,418 files · updated 4 minutes ago" changed={false}>
              <span className="inline-flex items-center gap-1.5 text-xs text-success">
                <span className="size-1.5 rounded-full bg-success" aria-hidden />
                Ready
              </span>
            </Row>
            <Row label="Pause indexing" hint="Search falls back to grep while paused" changed={paused} onReset={() => setPaused(false)}>
              <Switch checked={paused} onCheckedChange={setPaused} label="Pause indexing" />
            </Row>
          </Section>

          <Section id="voice" title="Voice">
            <Row label="Dictation" hint="Words appear as you speak; the accurate pass replaces them when you stop" changed={voice !== 'accurate'} onReset={() => setVoice('accurate')}>
              <Segmented
                label="Dictation"
                value={voice}
                onChange={setVoice}
                items={[
                  { id: 'fast', label: 'Fast' },
                  { id: 'accurate', label: 'Accurate' }
                ]}
              />
            </Row>
          </Section>

          <Section id="keys" title="Shortcuts">
            <ul className="border-t border-border/60">
              {SHORTCUTS.map(([keys, what]) => (
                <li key={what} className="flex h-9 items-center gap-3 border-b border-border/60 text-sm">
                  <span className="flex-1 text-fg">{what}</span>
                  <Keys keys={keys} />
                </li>
              ))}
            </ul>
          </Section>

          <Section id="about" title="About">
            <Row label="Agent V 1.0.0" hint="1.0.1 is downloaded and ready" changed={false}>
              <Button size="xs" variant="secondary" onClick={() => pushToast('Restarts when the 3 running tasks finish', { icon: 'refresh' })}>
                Restart to update
              </Button>
            </Row>
          </Section>
        </div>
      </div>
    </section>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-settings-section={id} aria-label={title} className="pt-6 first:pt-0">
      <h2 className="mb-1 text-sm font-semibold text-fg-strong">{title}</h2>
      <div className="border-t border-border/60">{children}</div>
    </section>
  )
}

function Row({ label, hint, changed, onReset, children, stack = false }: { label: string; hint?: string; changed: boolean; onReset?: () => void; children: ReactNode; stack?: boolean }) {
  return (
    <div className={cn('border-b border-border/60 py-3', stack ? '' : 'flex items-center gap-4')}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('text-sm', changed ? 'text-fg-strong' : 'text-secondary')}>{label}</span>
          {changed && onReset ? (
            <Button size="xs" variant="ghost" icon="undo" onClick={onReset}>
              Reset
            </Button>
          ) : null}
        </div>
        {hint ? <div className="text-xs text-tertiary">{hint}</div> : null}
      </div>
      {stack ? children : <div className="shrink-0">{children}</div>}
    </div>
  )
}

/** A skin rendered by the skin itself: its own planes, accent and radii. */
function SkinPreview({ skin, theme, on }: { skin: Skin; theme: Theme; on: boolean }) {
  return (
    <span
      data-skin={skin}
      data-theme={theme}
      className={cn('block h-[76px] overflow-hidden rounded-lg border bg-chrome vy-transition', on ? 'border-accent shadow-[0_0_0_1px_var(--vy-accent)]' : 'border-border group-hover:border-border-strong')}
    >
      <span className="flex h-full">
        <span className="flex w-[34%] flex-col gap-1 p-1.5">
          <span className="h-1.5 w-3/4 rounded-full bg-border-strong" />
          <span className="h-3 rounded-sm bg-surface-2" />
          <span className="h-1.5 w-2/3 rounded-full bg-border" />
          <span className="h-1.5 w-1/2 rounded-full bg-border" />
        </span>
        <span className="flex flex-1 flex-col gap-1 border-l border-border bg-bg p-1.5">
          <span className="h-3 rounded-sm border border-border bg-card" />
          <span className="h-1.5 w-5/6 rounded-full bg-border" />
          <span className="h-1.5 w-2/3 rounded-full bg-border" />
          <span className="mt-auto flex justify-end">
            <span className="size-3 rounded-full bg-accent" />
          </span>
        </span>
      </span>
    </span>
  )
}
