import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarketplaceCatalogEntry, Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import { CHAT_GUTTER, MARKETPLACE_COLUMN, SIDEBAR_NAV_ACTIVE } from '@renderer/lib/utils/layout'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { useEscapeToClose } from '@renderer/lib/hooks/useEscapeToClose'
import { Button, PageHeader, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { useMarketplaceController } from './useMarketplaceController'
import { MarketplaceHome } from './MarketplaceHome'
import { MarketplaceDetail } from './MarketplaceDetail'
import { MarketplaceManage } from './MarketplaceManage'
import { ConnectMcpWizard } from './ConnectMcpWizard'

const SECTION_TABS = ['browse', 'manage'] as const
type SectionTab = (typeof SECTION_TABS)[number]

const PANEL_IDS: Record<SectionTab, string> = {
  browse: 'marketplace-browse-panel',
  manage: 'marketplace-manage-panel'
}

type Pane =
  | { kind: 'home' }
  | { kind: 'detail'; entryId: string; fallback: MarketplaceCatalogEntry }
  | {
      kind: 'manage'
      returnTo?: { entryId: string; fallback: MarketplaceCatalogEntry }
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
  onFocusServerConsumed,
  onFocusSkillConsumed,
  onFocusRuleConsumed
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
  onFocusServerConsumed?: () => void
  onFocusSkillConsumed?: () => void
  onFocusRuleConsumed?: () => void
}) {
  const [pane, setPane] = useState<Pane>(() =>
    focusServerId || focusSkillPath || focusRulePath ? { kind: 'manage' } : { kind: 'home' }
  )
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)
  const [manageFocusServerId, setManageFocusServerId] = useState<string | null>(
    focusServerId ?? null
  )
  const [manageFocusSkillPath, setManageFocusSkillPath] = useState<string | null>(
    focusSkillPath ?? null
  )
  const [manageFocusRulePath, setManageFocusRulePath] = useState<string | null>(
    focusRulePath ?? null
  )
  const [manageOpenMcpAdd, setManageOpenMcpAdd] = useState(false)
  const controller = useMarketplaceController({
    settings,
    onUpdate,
    onReloadSettings,
    activeWorkspacePath,
    settingsOverridesByPath
  })
  const searchRef = useRef<HTMLInputElement>(null)
  const paneRef = useRef(pane)
  paneRef.current = pane

  useEffect(() => {
    const id = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!focusServerId) return
    setPane({ kind: 'manage' })
    setManageFocusServerId(focusServerId)
    onFocusServerConsumed?.()
  }, [focusServerId, onFocusServerConsumed])

  useEffect(() => {
    if (!focusSkillPath) return
    setPane({ kind: 'manage' })
    setManageFocusSkillPath(focusSkillPath)
    onFocusSkillConsumed?.()
  }, [focusSkillPath, onFocusSkillConsumed])

  useEffect(() => {
    if (!focusRulePath) return
    setPane({ kind: 'manage' })
    setManageFocusRulePath(focusRulePath)
    onFocusRuleConsumed?.()
  }, [focusRulePath, onFocusRuleConsumed])

  const detailEntry =
    pane.kind === 'detail'
      ? (controller.catalog.find((e) => e.id === pane.entryId) ?? pane.fallback)
      : null

  const openDetail = (entry: MarketplaceCatalogEntry): void => {
    setSelectedEntryId(entry.id)
    setPane({ kind: 'detail', entryId: entry.id, fallback: entry })
  }

  const openBrowse = (): void => {
    setManageFocusServerId(null)
    setManageFocusSkillPath(null)
    setManageFocusRulePath(null)
    setManageOpenMcpAdd(false)
    setPane({ kind: 'home' })
  }

  const openManage = (
    returnTo?: { entryId: string; fallback: MarketplaceCatalogEntry },
    opts?: { mcpAdd?: boolean }
  ): void => {
    if (opts?.mcpAdd) setManageOpenMcpAdd(true)
    setPane(returnTo ? { kind: 'manage', returnTo } : { kind: 'manage' })
  }

  const popOrClose = useCallback((): void => {
    const current = paneRef.current
    if (current.kind === 'detail') {
      openBrowse()
      return
    }
    if (current.kind === 'manage') {
      setManageFocusServerId(null)
      setManageFocusSkillPath(null)
      setManageFocusRulePath(null)
      setManageOpenMcpAdd(false)
      if (current.returnTo) {
        setSelectedEntryId(current.returnTo.entryId)
        setPane({
          kind: 'detail',
          entryId: current.returnTo.entryId,
          fallback: current.returnTo.fallback
        })
      } else {
        setPane({ kind: 'home' })
      }
      return
    }
    onClose?.()
  }, [onClose])

  useEscapeToClose(popOrClose, pane.kind !== 'home' || Boolean(onClose), {
    deferToMenus: true
  })

  const browseActive = pane.kind === 'home' || pane.kind === 'detail'
  const manageActive = pane.kind === 'manage'
  const sectionTab: SectionTab = manageActive ? 'manage' : 'browse'

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-bg pt-9 animate-fade-in"
      data-marketplace-shell
    >
      <PageHeader
        bordered={false}
        className={cn(
          'shrink-0 border-b border-border/30 bg-bg py-3',
          CHAT_GUTTER
        )}
        title="Marketplace"
        description="MCP servers, skills, and packages for the agent."
        trailing={
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <div
              className="flex gap-0.5"
              role="tablist"
              aria-label="Marketplace sections"
              tabIndex={-1}
              onKeyDown={(e) =>
                handleTabListKeyDown(e, {
                  tabs: [...SECTION_TABS],
                  activeId: sectionTab,
                  onSelect: (id) => {
                    if (id === 'browse') openBrowse()
                    else openManage()
                  }
                })
              }
            >
              <Button
                id="marketplace-tab-browse"
                role="tab"
                aria-selected={browseActive}
                aria-controls={PANEL_IDS.browse}
                tabIndex={browseActive ? 0 : -1}
                variant="ghost"
                className={cn('min-h-7 px-2.5', browseActive && SIDEBAR_NAV_ACTIVE)}
                onClick={openBrowse}
              >
                Browse
              </Button>
              <Button
                id="marketplace-tab-manage"
                role="tab"
                aria-selected={manageActive}
                aria-controls={PANEL_IDS.manage}
                tabIndex={manageActive ? 0 : -1}
                variant="ghost"
                className={cn('min-h-7 px-2.5', manageActive && SIDEBAR_NAV_ACTIVE)}
                onClick={() => openManage()}
              >
                Manage
              </Button>
            </div>
            {onClose ? (
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm text-muted vy-transition hover:bg-surface/50 hover:text-fg focus-visible:vy-focus-ring"
                onClick={onClose}
              >
                <Icon name="chevron" size={14} className="-rotate-90" />
                Close
              </button>
            ) : null}
          </div>
        }
      />

      <div className={cn('min-h-0 flex-1 overflow-y-auto', CHAT_GUTTER, 'py-5')}>
        <div className={MARKETPLACE_COLUMN}>
          {browseActive ? (
            <div
              id={PANEL_IDS.browse}
              role="tabpanel"
              aria-labelledby="marketplace-tab-browse"
            >
              {pane.kind === 'home' ? (
                <MarketplaceHome
                  controller={controller}
                  selectedEntryId={selectedEntryId}
                  searchRef={searchRef}
                  onOpenDetail={openDetail}
                  onOpenManage={(opts) => openManage(undefined, opts)}
                  onRequestClose={popOrClose}
                />
              ) : null}
              {pane.kind === 'detail' && detailEntry ? (
                <MarketplaceDetail
                  entry={detailEntry}
                  controller={controller}
                  onBack={openBrowse}
                  onOpenManage={() =>
                    openManage({ entryId: detailEntry.id, fallback: detailEntry })
                  }
                />
              ) : null}
            </div>
          ) : null}
          {pane.kind === 'manage' ? (
            <div
              id={PANEL_IDS.manage}
              role="tabpanel"
              aria-labelledby="marketplace-tab-manage"
            >
              <MarketplaceManage
                controller={controller}
                settings={settings}
                onUpdate={onUpdate}
                onReloadSettings={onReloadSettings}
                activeWorkspacePath={activeWorkspacePath}
                settingsOverridesByPath={settingsOverridesByPath}
                onSetSettingsOverride={onSetSettingsOverride}
                focusServerId={manageFocusServerId}
                focusSkillPath={manageFocusSkillPath}
                focusRulePath={manageFocusRulePath}
                openMcpAdd={manageOpenMcpAdd}
                onOpenMcpAddConsumed={() => setManageOpenMcpAdd(false)}
                onFocusSkillConsumed={() => setManageFocusSkillPath(null)}
                onFocusRuleConsumed={() => setManageFocusRulePath(null)}
                onBack={popOrClose}
              />
            </div>
          ) : null}
        </div>
      </div>
      {controller.connectWizardId ? (
        <ConnectMcpWizard
          serverId={controller.connectWizardId}
          serverName={
            settings.mcpServers.find((s) => s.id === controller.connectWizardId)?.name ??
            controller.catalog.find((e) => e.id === controller.connectWizardId)?.name ??
            controller.connectWizardId
          }
          settings={settings}
          status={controller.mcpStatusById.get(controller.connectWizardId)}
          hasGoogleMcpClientSecret={controller.hasGoogleMcpClientSecret}
          activeWorkspacePath={activeWorkspacePath}
          onUpdate={onUpdate}
          onReloadSettings={onReloadSettings}
          onClose={controller.closeConnectWizard}
          onConnected={() => {
            void controller.loadMcpStatus(true)
          }}
        />
      ) : null}
    </div>
  )
}
