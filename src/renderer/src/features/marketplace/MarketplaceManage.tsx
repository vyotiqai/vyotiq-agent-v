import { useEffect, useState } from 'react'
import type { Settings, WorkspaceSettingsOverride } from '@shared/ipc'
import { findByWorkspacePath } from '@shared/workspacePathMatch'
import { Button } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { MarketplaceFeedbackBanner } from './MarketplaceFeedbackBanner'
import { MarketplaceInstalledList } from './MarketplaceInstalledList'
import { RegistrySettingsPanel } from './RegistrySettingsPanel'
import { MarketplaceMcpPane } from './MarketplaceMcpPane'
import { MarketplaceSkillsPane } from './MarketplaceSkillsPane'
import { MarketplaceRulesPane } from './MarketplaceRulesPane'
import type { MarketplaceController } from './useMarketplaceController'

export const MANAGE_KINDS = ['mcps', 'skills', 'rules', 'packages'] as const
export type ManageKind = (typeof MANAGE_KINDS)[number]

const KIND_LABEL: Record<ManageKind, string> = {
  mcps: 'MCPs',
  skills: 'Skills',
  rules: 'Rules',
  packages: 'Packages'
}

export function MarketplaceManage({
  controller,
  settings,
  onUpdate,
  onReloadSettings,
  activeWorkspacePath,
  settingsOverridesByPath,
  onSetSettingsOverride,
  onBack,
  focusServerId,
  focusSkillPath,
  focusRulePath,
  openMcpAdd,
  onOpenMcpAddConsumed,
  onFocusSkillConsumed,
  onFocusRuleConsumed
}: {
  controller: MarketplaceController
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  onReloadSettings?: () => Promise<void>
  activeWorkspacePath?: string | null
  settingsOverridesByPath?: Record<string, WorkspaceSettingsOverride>
  onSetSettingsOverride?: (
    path: string,
    override: WorkspaceSettingsOverride | null
  ) => Promise<{ ok: true } | { ok: false; error: string }>
  onBack: () => void
  focusServerId?: string | null
  focusSkillPath?: string | null
  focusRulePath?: string | null
  openMcpAdd?: boolean
  onOpenMcpAddConsumed?: () => void
  onFocusSkillConsumed?: () => void
  onFocusRuleConsumed?: () => void
}) {
  const [kind, setKind] = useState<ManageKind>(() => {
    if (focusSkillPath) return 'skills'
    if (focusRulePath) return 'rules'
    return 'mcps'
  })
  const { formLocked, feedback, setFeedback, workspaceEnabledForId } = controller

  useEffect(() => {
    if (focusServerId || openMcpAdd) setKind('mcps')
  }, [focusServerId, openMcpAdd])

  useEffect(() => {
    if (focusSkillPath) setKind('skills')
  }, [focusSkillPath])

  useEffect(() => {
    if (focusRulePath) setKind('rules')
  }, [focusRulePath])

  const workspaceOverride =
    activeWorkspacePath && settingsOverridesByPath
      ? (findByWorkspacePath(settingsOverridesByPath, activeWorkspacePath) ?? undefined)
      : undefined

  const setWorkspaceEnable = async (
    enableKind: 'mcp' | 'skills' | 'plugins',
    id: string,
    enabled: boolean
  ) => {
    if (!activeWorkspacePath || !onSetSettingsOverride) return
    const prev = workspaceOverride ?? { useOverride: false as const }
    const marketplaceOverrides = {
      ...(prev.marketplaceOverrides ?? {}),
      [enableKind]: {
        ...(prev.marketplaceOverrides?.[enableKind] ?? {}),
        [id]: enabled
      }
    }
    const res = await onSetSettingsOverride(activeWorkspacePath, {
      ...prev,
      marketplaceOverrides
    })
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  const clearWorkspaceEnable = async (
    enableKind: 'mcp' | 'skills' | 'plugins',
    id: string
  ) => {
    if (!activeWorkspacePath || !onSetSettingsOverride || !workspaceOverride) return
    const kindMap = { ...(workspaceOverride.marketplaceOverrides?.[enableKind] ?? {}) }
    if (!Object.prototype.hasOwnProperty.call(kindMap, id)) return
    delete kindMap[id]
    const marketplaceOverrides = {
      ...(workspaceOverride.marketplaceOverrides ?? {}),
      [enableKind]: kindMap
    }
    const res = await onSetSettingsOverride(activeWorkspacePath, {
      ...workspaceOverride,
      marketplaceOverrides
    })
    if (!res.ok) setFeedback({ kind: 'error', text: res.error })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1.5 text-xs text-muted" aria-label="Breadcrumb">
          <button
            type="button"
            className="text-secondary vy-transition hover:text-fg focus-visible:vy-focus-ring"
            onClick={onBack}
          >
            Marketplace
          </button>
          <Icon name="chevronRight" size={12} className="text-muted" />
          <span className="text-fg">Manage</span>
        </nav>
        <div
          className="flex flex-wrap gap-1"
          role="tablist"
          aria-label="Manage marketplace"
          tabIndex={-1}
          onKeyDown={(e) =>
            handleTabListKeyDown(e, {
              tabs: [...MANAGE_KINDS],
              activeId: kind,
              onSelect: (id) => setKind(id as ManageKind)
            })
          }
        >
          {MANAGE_KINDS.map((t) => (
            <Button
              key={t}
              id={`marketplace-manage-tab-${t}`}
              role="tab"
              aria-selected={kind === t}
              aria-controls={`marketplace-manage-panel-${t}`}
              tabIndex={kind === t ? 0 : -1}
              variant="subtle"
              className={kind === t ? 'bg-surface text-fg-strong ring-1 ring-inset ring-border/50' : undefined}
              disabled={formLocked}
              onClick={() => setKind(t)}
            >
              {KIND_LABEL[t]}
            </Button>
          ))}
        </div>
      </div>

      <RegistrySettingsPanel
        settings={settings}
        formLocked={formLocked}
        onUpdate={onUpdate}
        onReloadSettings={onReloadSettings}
      />

      {activeWorkspacePath && onSetSettingsOverride && (kind === 'packages' || kind === 'mcps') ? (
        <p className="m-0 rounded-md border border-border bg-surface px-2.5 py-2 text-xs text-secondary">
          Force on/off enables workspace overrides for this workspace and overrides global package
          enablement for agent runs here. Global MCP connections stay up for other workspaces
          (Settings → General → Workspaces).
        </p>
      ) : null}

      <MarketplaceFeedbackBanner feedback={feedback} />

      {kind === 'mcps' ? (
        <div
          id="marketplace-manage-panel-mcps"
          role="tabpanel"
          aria-labelledby="marketplace-manage-tab-mcps"
        >
          <MarketplaceMcpPane
            controller={controller}
            settings={settings}
            activeWorkspacePath={activeWorkspacePath}
            canOverride={!!onSetSettingsOverride}
            setWorkspaceEnable={setWorkspaceEnable}
            clearWorkspaceEnable={clearWorkspaceEnable}
            workspaceEnabledForId={workspaceEnabledForId}
            openAdd={openMcpAdd}
            onOpenAddConsumed={onOpenMcpAddConsumed}
            focusServerId={focusServerId}
          />
        </div>
      ) : null}

      {kind === 'skills' ? (
        <div
          id="marketplace-manage-panel-skills"
          role="tabpanel"
          aria-labelledby="marketplace-manage-tab-skills"
        >
          <MarketplaceSkillsPane
            controller={controller}
            activeWorkspacePath={activeWorkspacePath}
            focusSkillPath={focusSkillPath}
            onFocusSkillConsumed={onFocusSkillConsumed}
          />
        </div>
      ) : null}

      {kind === 'rules' ? (
        <div
          id="marketplace-manage-panel-rules"
          role="tabpanel"
          aria-labelledby="marketplace-manage-tab-rules"
        >
          <MarketplaceRulesPane
            controller={controller}
            settings={settings}
            onUpdate={onUpdate}
            activeWorkspacePath={activeWorkspacePath}
            focusRulePath={focusRulePath}
            onFocusRuleConsumed={onFocusRuleConsumed}
          />
        </div>
      ) : null}

      {kind === 'packages' ? (
        <div
          id="marketplace-manage-panel-packages"
          role="tabpanel"
          aria-labelledby="marketplace-manage-tab-packages"
        >
          <MarketplaceInstalledList
            controller={controller}
            settings={settings}
            activeWorkspacePath={activeWorkspacePath}
            canOverride={!!onSetSettingsOverride}
            setWorkspaceEnable={setWorkspaceEnable}
            clearWorkspaceEnable={clearWorkspaceEnable}
            workspaceEnabledForId={workspaceEnabledForId}
          />
        </div>
      ) : null}
    </div>
  )
}
