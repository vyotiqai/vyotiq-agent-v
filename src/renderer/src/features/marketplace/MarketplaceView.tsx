import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Settings, UserRule, WorkspaceSettingsOverride } from '@shared/ipc'
import { MAX_USER_RULES, USER_RULE_NAME_MAX } from '@shared/ipc'
import { basename } from '@shared/utils/path'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'
import { ActionMenu, Button, IconButton, SearchInput, Tabs, pushToast, type ActionMenuItem } from '@renderer/lib/ui'
import { AddMcpDialog } from './AddMcpDialog'
import { ConnectMcpWizard } from './ConnectMcpWizard'
import { ExtensionDetail, type EditorTarget } from './ExtensionDetail'
import { ExtensionEditor } from './ExtensionEditor'
import { ExtensionList } from './ExtensionList'
import { RegistryTrustDialog } from './RegistryTrustDialog'
import {
  buildExtensionItems,
  extensionInTab,
  extensionMatchesQuery,
  extensionSections,
  extensionTabCounts,
  type ExtensionItem,
  type ExtensionTab
} from './extensionItems'
import { useMarketplaceController } from './useMarketplaceController'

/** The tabs Settings and the slash commands can open on. */
export type ExtensionsFocusTab = 'mcps' | 'skills' | 'rules' | 'packages'

const TAB_OF_FOCUS: Record<ExtensionsFocusTab, ExtensionTab> = {
  mcps: 'mcp',
  skills: 'skills',
  rules: 'rules',
  packages: 'packages'
}

const TAB_LABEL: Record<ExtensionTab, string> = {
  all: 'All',
  mcp: 'MCP servers',
  skills: 'Skills',
  rules: 'Rules',
  packages: 'Packages'
}

const TABS: readonly ExtensionTab[] = ['all', 'mcp', 'skills', 'rules', 'packages']

const EMPTY_TAB: Record<ExtensionTab, string> = {
  all: 'Nothing here yet.',
  mcp: 'No MCP servers yet.',
  skills: 'No skills yet.',
  rules: 'No rules yet.',
  packages: 'No packages in the catalog.'
}

function slashPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/** The item a server id names: a server row, or the package that ships it. */
function itemForServer(items: readonly ExtensionItem[], serverId: string): ExtensionItem | undefined {
  return (
    items.find((i) => i.key === `server:${serverId}`) ??
    items.find((i) => i.kind === 'mcp' && (i.server?.id === serverId || i.id === serverId))
  )
}

function rowFor(key: string): HTMLElement | undefined {
  // Compare the attribute rather than build a selector: keys carry paths.
  return Array.from(document.querySelectorAll<HTMLElement>('[data-extension-key]')).find(
    (el) => el.dataset.extensionKey === key
  )
}

export function MarketplaceView({
  settings,
  onUpdate,
  onReloadSettings,
  activeWorkspacePath,
  settingsOverridesByPath,
  onSetSettingsOverride,
  onClose,
  focusServerId,
  focusSkillPath,
  focusRulePath,
  focusManageTab,
  onFocusServerConsumed,
  onFocusSkillConsumed,
  onFocusRuleConsumed,
  onFocusManageTabConsumed
}: {
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
  activeWorkspacePath?: string | null
  settingsOverridesByPath?: Record<string, WorkspaceSettingsOverride>
  onSetSettingsOverride?: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onClose?: () => void
  focusServerId?: string | null
  focusSkillPath?: string | null
  focusRulePath?: string | null
  /** Open on one kind (Settings links here). */
  focusManageTab?: ExtensionsFocusTab | null
  onFocusServerConsumed?: () => void
  onFocusSkillConsumed?: () => void
  onFocusRuleConsumed?: () => void
  onFocusManageTabConsumed?: () => void
}) {
  const controller = useMarketplaceController({
    settings,
    onUpdate,
    onReloadSettings,
    activeWorkspacePath,
    settingsOverridesByPath,
    onSetSettingsOverride
  })
  const { confirm, dialog: confirmDialog } = useConfirm()
  const { prompt, dialog: promptDialog } = usePrompt()
  const [tab, setTab] = useState<ExtensionTab>(() => (focusManageTab ? TAB_OF_FOCUS[focusManageTab] : 'all'))
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pendingServerId, setPendingServerId] = useState<string | null>(focusServerId ?? null)
  const [editor, setEditor] = useState<EditorTarget | null>(() =>
    focusSkillPath
      ? { kind: 'skill', skillPath: focusSkillPath }
      : focusRulePath
        ? { kind: 'project-rule', path: slashPath(focusRulePath) }
        : null
  )
  const [addOpen, setAddOpen] = useState(false)
  const [trustOpen, setTrustOpen] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const workspacePath = controller.workspacePath
  const workspaceName = workspacePath ? basename(workspacePath) : null

  useEffect(() => {
    if (!focusServerId) return
    setPendingServerId(focusServerId)
    setEditor(null)
    setQuery('')
    onFocusServerConsumed?.()
  }, [focusServerId, onFocusServerConsumed])

  useEffect(() => {
    if (!focusSkillPath) return
    setEditor({ kind: 'skill', skillPath: focusSkillPath })
    onFocusSkillConsumed?.()
  }, [focusSkillPath, onFocusSkillConsumed])

  useEffect(() => {
    if (!focusRulePath) return
    setEditor({ kind: 'project-rule', path: slashPath(focusRulePath) })
    onFocusRuleConsumed?.()
  }, [focusRulePath, onFocusRuleConsumed])

  useEffect(() => {
    if (!focusManageTab) return
    setTab(TAB_OF_FOCUS[focusManageTab])
    setEditor(null)
    onFocusManageTabConsumed?.()
  }, [focusManageTab, onFocusManageTabConsumed])

  useEffect(() => {
    if (editor) return
    const id = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [editor])

  const items = useMemo(
    () =>
      buildExtensionItems({
        catalog: controller.catalog,
        installed: controller.installed.items,
        servers: settings.mcpServers,
        statusById: controller.mcpStatusById,
        localSkills: controller.localSkills,
        userRules: settings.userRules ?? [],
        projectRules: controller.projectRules,
        overrides: controller.workspaceOverrides,
        workspaceName
      }),
    [
      controller.catalog,
      controller.installed.items,
      settings.mcpServers,
      controller.mcpStatusById,
      controller.localSkills,
      settings.userRules,
      controller.projectRules,
      controller.workspaceOverrides,
      workspaceName
    ]
  )
  const catalogById = useMemo(() => new Map(controller.catalog.map((e) => [e.id, e])), [controller.catalog])
  const matching = useMemo(() => items.filter((i) => extensionMatchesQuery(i, query)), [items, query])
  const counts = useMemo(() => extensionTabCounts(matching), [matching])
  const sections = useMemo(() => extensionSections(matching.filter((i) => extensionInTab(i, tab))), [matching, tab])
  const visible = useMemo(() => sections.flatMap((s) => s.items), [sections])
  // The one asked for when it is showing; otherwise the first row, so the
  // detail is never empty beside a list that is not.
  const selected = visible.find((i) => i.key === selectedKey) ?? visible[0] ?? null

  // A server named from elsewhere (Home, the composer) is selected once its
  // row exists — the catalog and status arrive after the first render.
  useEffect(() => {
    if (!pendingServerId) return
    const item = itemForServer(items, pendingServerId)
    if (!item) return
    setPendingServerId(null)
    setTab((t) => (extensionInTab(item, t) ? t : 'all'))
    setSelectedKey(item.key)
    window.requestAnimationFrame(() => rowFor(item.key)?.scrollIntoView({ block: 'nearest' }))
  }, [pendingServerId, items])

  const select = useCallback((key: string | null): void => {
    if (!key) return
    setSelectedKey(key)
    window.requestAnimationFrame(() => rowFor(key)?.scrollIntoView({ block: 'nearest' }))
  }, [])

  const dialogOpen = addOpen || trustOpen || Boolean(controller.connectWizardId)
  const closeView = useCallback((): void => onClose?.(), [onClose])
  const closeEditor = useCallback((): void => setEditor(null), [])
  useEscapeToClose(closeView, !editor && !dialogOpen && Boolean(onClose), { deferToMenus: true })

  /* ─── Creating skills and rules ─────────────────────────────────────── */

  const createSkill = async (scope: 'personal' | 'project'): Promise<void> => {
    const title = await prompt(scope === 'personal' ? 'New user skill name' : 'New workspace skill name', '')
    if (title == null) return
    if (!title.trim()) {
      pushToast('Skill name cannot be empty.', 'error')
      return
    }
    const res = await window.vyotiq.slashCommandsCreateSkill({ workspacePath, title: title.trim(), scope })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    pushToast(`Created ${res.data.relativePath}.`, 'success')
    setEditor({ kind: 'skill', skillPath: res.data.path })
  }

  const userRuleCount = (settings.userRules ?? []).length
  const createUserRule = async (): Promise<void> => {
    const rules = settings.userRules ?? []
    const name = await prompt('New user rule name', '')
    if (name == null) return
    if (!name.trim()) {
      pushToast('User rule name cannot be empty.', 'error')
      return
    }
    const rule: UserRule = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, USER_RULE_NAME_MAX),
      body: '',
      enabled: true
    }
    const res = await onUpdate({ userRules: [...rules, rule] })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    setEditor({ kind: 'user-rule', ruleId: rule.id })
  }

  const createProjectRule = async (): Promise<void> => {
    if (!workspacePath) return
    const title = await prompt('New project rule name', '')
    if (title == null) return
    if (!title.trim()) {
      pushToast('Rule name cannot be empty.', 'error')
      return
    }
    const res = await window.vyotiq.slashCommandsCreateRule({ workspacePath, title: title.trim() })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    pushToast(`Created ${res.data.relativePath}.`, 'success')
    await controller.loadProjectRules()
    setEditor({ kind: 'project-rule', path: slashPath(res.data.relativePath) })
  }

  const newMenu: { label: string; items: ActionMenuItem[] } | null =
    tab === 'skills'
      ? {
          label: 'New skill',
          items: [
            { id: 'personal', label: 'User skill', icon: 'skill', onSelect: () => void createSkill('personal') },
            {
              id: 'project',
              label: 'Workspace skill',
              icon: 'folder',
              disabled: !workspacePath,
              disabledReason: 'Open a workspace first.',
              onSelect: () => void createSkill('project')
            }
          ]
        }
      : tab === 'rules'
        ? {
            label: 'New rule',
            items: [
              {
                id: 'user',
                label: 'User rule',
                icon: 'rules',
                disabled: userRuleCount >= MAX_USER_RULES,
                disabledReason: `${MAX_USER_RULES} user rules is the most there can be.`,
                onSelect: () => void createUserRule()
              },
              {
                id: 'project',
                label: 'Project rule',
                icon: 'folder',
                disabled: !workspacePath,
                disabledReason: 'Open a workspace first.',
                onSelect: () => void createProjectRule()
              }
            ]
          }
        : null

  const addButton = newMenu ? (
    <ActionMenu
      aria-label={newMenu.label}
      open={newMenuOpen}
      onOpenChange={setNewMenuOpen}
      placement="down"
      align="end"
      items={newMenu.items}
      trigger={(props) => (
        <Button
          ref={props.ref}
          size="xs"
          variant="ghost"
          icon="plus"
          disabled={controller.formLocked}
          aria-expanded={props['aria-expanded']}
          aria-controls={props['aria-controls']}
          aria-haspopup={props['aria-haspopup']}
          onClick={props.onClick}
        >
          {newMenu.label}
        </Button>
      )}
    />
  ) : (
    <Button size="xs" variant="ghost" icon="plus" disabled={controller.formLocked} onClick={() => setAddOpen(true)}>
      Add MCP server
    </Button>
  )

  const wizardId = controller.connectWizardId

  return (
    <div className="flex h-full min-h-0 flex-col" data-marketplace-shell>
      <h1 className="sr-only">Extensions</h1>
      {editor ? (
        <ExtensionEditor
          target={editor}
          controller={controller}
          settings={settings}
          onUpdate={onUpdate}
          confirm={confirm}
          onBack={closeEditor}
          onRetarget={setEditor}
        />
      ) : (
        <>
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border pl-4 pr-2">
            <Tabs
              size="sm"
              label="Extension kinds"
              value={tab}
              onChange={setTab}
              panelIdPrefix="extensions-panel-"
              items={TABS.map((id) => ({ id, label: TAB_LABEL[id], count: counts[id] }))}
            />
            <span className="flex-1" />
            <SearchInput
              ref={searchRef}
              size="sm"
              className="w-56"
              aria-label="Search extensions"
              placeholder="Search extensions"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery('')}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                // Clear first, then leave: the field swallows Escape otherwise.
                e.preventDefault()
                if (query) setQuery('')
                else onClose?.()
              }}
            />
            {addButton}
            <IconButton icon="gear" label="Registry and trust" size="sm" tone="muted" onClick={() => setTrustOpen(true)} />
          </div>

          <div className="flex min-h-0 flex-1">
            <div
              id={`extensions-panel-${tab}`}
              role="tabpanel"
              aria-label={TAB_LABEL[tab]}
              className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-8"
            >
              {sections.length > 0 ? (
                <ExtensionList
                  sections={sections}
                  selectedKey={selected?.key ?? null}
                  catalogById={catalogById}
                  addingId={controller.busyTargetId}
                  disabled={controller.formLocked}
                  onSelect={select}
                  onAdd={(item) => {
                    if (!item.entry) return
                    select(item.key)
                    void controller.installFromCatalog(item.entry)
                  }}
                />
              ) : controller.catalogLoading && items.length === 0 ? (
                <p role="status" className="mt-5 text-xs text-muted">
                  Loading extensions…
                </p>
              ) : query.trim() ? (
                <div className="mt-5 flex items-center gap-2 text-xs text-muted">
                  Nothing matches “{query.trim()}”.
                  <Button size="xs" variant="ghost" onClick={() => setQuery('')}>
                    Clear search
                  </Button>
                </div>
              ) : (
                <p className="mt-5 text-xs text-muted">{EMPTY_TAB[tab]}</p>
              )}
            </div>
            {selected ? (
              <ExtensionDetail
                key={selected.key}
                item={selected}
                controller={controller}
                settings={settings}
                catalogById={catalogById}
                workspaceName={workspaceName}
                onUpdate={onUpdate}
                confirm={confirm}
                onEdit={setEditor}
              />
            ) : null}
          </div>
        </>
      )}

      {addOpen ? (
        <AddMcpDialog
          controller={controller}
          onClose={() => setAddOpen(false)}
          onAdded={(key) => {
            setAddOpen(false)
            setEditor(null)
            setQuery('')
            if (key) {
              setTab('all')
              select(key)
            }
          }}
          onUseCatalog={(id) => {
            setAddOpen(false)
            setQuery('')
            setTab('all')
            select(`mcp:${id}`)
          }}
        />
      ) : null}
      {trustOpen ? (
        <RegistryTrustDialog
          settings={settings}
          controller={controller}
          onUpdate={onUpdate}
          onReloadSettings={onReloadSettings}
          onClose={() => setTrustOpen(false)}
          onInstalled={(key) => {
            setTrustOpen(false)
            setQuery('')
            setTab('all')
            select(key)
          }}
        />
      ) : null}
      {wizardId ? (
        <ConnectMcpWizard
          serverId={wizardId}
          serverName={
            settings.mcpServers.find((s) => s.id === wizardId)?.name ??
            controller.catalog.find((e) => e.id === wizardId)?.name ??
            wizardId
          }
          settings={settings}
          status={controller.mcpStatusById.get(wizardId)}
          hasGoogleMcpClientSecret={controller.hasGoogleMcpClientSecret}
          hasGoogleMcpClient={controller.hasGoogleMcpClient}
          activeWorkspacePath={activeWorkspacePath}
          onUpdate={onUpdate}
          onReloadSettings={onReloadSettings}
          onClose={controller.closeConnectWizard}
          onConnected={() => {
            void controller.loadMcpStatus(true)
          }}
        />
      ) : null}
      {confirmDialog}
      {promptDialog}
    </div>
  )
}
