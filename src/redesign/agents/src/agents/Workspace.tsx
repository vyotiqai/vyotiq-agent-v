import { IconButton, Tabs, cn, type TabItem } from '@renderer/lib/ui'
import { Review } from './Review'
import { diffsOf, hasPage, taskOf, terminalOf } from './runtime'
import { BrowserView, FileView, FilesTree, PlanDoc, PullRequest, TerminalView } from './SideViews'
import { WS_TABS, useAgents, type WsTab } from './store'

/*
  The side pane is the app's inspector: six tabs, always there, always in the
  same order, so Alt 1–6 and the eye both land on the same place every time.
  A tab says what is waiting in it (Review's file count) or that the task is
  working there right now (a live dot), never with a second row of chrome.
  A file opens inside Files; an instance opens in place of the record.
*/

const LABEL: Record<WsTab, string> = {
  review: 'Review',
  files: 'Files',
  terminal: 'Terminal',
  browser: 'Browser',
  pr: 'PR',
  plan: 'Plan'
}

export function Workspace({ width }: { width: number | 'full' }) {
  const { s, d } = useAgents()
  const t = taskOf(s, s.agent)
  const files = diffsOf(s, t.id).length
  const running = t.state === 'running'
  const live: Partial<Record<WsTab, boolean>> = {
    terminal: running && terminalOf(s, t.id).some((c) => c.live),
    browser: running && hasPage(t.id)
  }
  const items: TabItem<WsTab>[] = WS_TABS.map((id, i) => ({
    id,
    label: LABEL[id],
    ...(id === 'review' && files ? { count: files } : {}),
    ...(live[id] ? { live: true } : {}),
    title: `Alt ${i + 1}`
  }))

  return (
    <aside aria-label="Side pane" className={cn('vy-panel flex h-full min-h-0 flex-col', width === 'full' ? 'min-w-0 flex-1' : 'shrink-0')} style={width === 'full' ? undefined : { width }}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <Tabs
          items={items}
          value={s.wsTab}
          onChange={(tab) => d({ type: 'ws', tab })}
          size="sm"
          label="Side pane"
          panelIdPrefix="side-panel-"
          // A narrow pane scrolls its strip sideways, as the app's inspector does.
          className="min-w-0 flex-1 overflow-x-auto pb-px [scrollbar-width:none]"
        />
        <IconButton
          icon={s.sideFull ? 'collapse' : 'expand'}
          label={s.sideFull ? 'Back beside the task (Ctrl+Shift+I)' : 'Full width (Ctrl+Shift+I)'}
          size="sm"
          tone="muted"
          active={s.sideFull}
          onClick={() => d({ type: 'sideFull', on: !s.sideFull })}
        />
        <IconButton icon="close" label="Hide the side pane (Ctrl+I)" size="sm" tone="muted" onClick={() => (d({ type: 'sideFull', on: false }), d({ type: 'ws', open: false }))} />
      </div>

      <div id={`side-panel-${s.wsTab}`} className="min-h-0 flex-1" role="tabpanel" aria-label={LABEL[s.wsTab]}>
        {s.wsTab === 'review' ? <Review /> : null}
        {s.wsTab === 'files' ? s.file ? <FileView path={s.file} /> : <FilesTree /> : null}
        {s.wsTab === 'terminal' ? <TerminalView /> : null}
        {s.wsTab === 'browser' ? <BrowserView /> : null}
        {s.wsTab === 'pr' ? <PullRequest /> : null}
        {s.wsTab === 'plan' ? <PlanDoc /> : null}
      </div>
    </aside>
  )
}
