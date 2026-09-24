import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  MarketplaceCatalogEntry,
  PackageContents,
  Settings,
  ToolCatalogEntry,
  UserRule
} from '@shared/ipc'
import { GITHUB_MCP_ID, isGoogleMcpId, mcpSupportsOAuth, mcpUsesTokenAuth } from '@shared/mcpApps'
import { workspaceOverrideForId } from '@shared/domain/marketplaceEnablement'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, Segmented, cn, pushToast } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { BrandTile } from './BrandTile'
import { extensionTile } from './ExtensionList'
import { McpServerConfig } from './McpServerConfig'
import {
  extensionKindLabel,
  mcpLaunchLine,
  whereValue,
  wherePlan,
  type ExtensionItem,
  type McpLaunch,
  type WhereValue
} from './extensionItems'
import type { MarketplaceController } from './useMarketplaceController'

export type EditorTarget =
  | { kind: 'skill'; skillPath: string }
  | { kind: 'user-rule'; ruleId: string }
  | { kind: 'project-rule'; path: string }

export type ConfirmFn = (
  message: string,
  options?: { title?: string; confirmLabel?: string; danger?: boolean }
) => Promise<boolean>

const TOOLS_SHOWN = 6

const ROOT_RULE_FILES = new Set(['agents.md', 'claude.md', '.cursorrules'])

export function isRootRulePath(path: string): boolean {
  const base = path.replace(/\\/g, '/').toLowerCase().split('/').pop() ?? ''
  return ROOT_RULE_FILES.has(base)
}

/** Why an MCP tool is out of the next step's catalog, in the row's words. */
const INACTIVE_REASON: Record<NonNullable<ToolCatalogEntry['reason']>, string> = {
  'server-disabled': 'server off',
  'auth-not-allowed': 'not signed in here',
  'denied-by-policy': 'blocked',
  'auto-mode-switch-off': 'inactive',
  'code-index-off': 'inactive'
}

export function ExtensionDetail({
  item,
  controller,
  settings,
  catalogById,
  workspaceName,
  onUpdate,
  confirm,
  onEdit
}: {
  item: ExtensionItem
  controller: MarketplaceController
  settings: Settings
  catalogById: ReadonlyMap<string, MarketplaceCatalogEntry>
  workspaceName: string | null
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  confirm: ConfirmFn
  onEdit: (target: EditorTarget) => void
}) {
  const contents = usePackageContents(item)
  const version = item.installed?.version ?? item.entry?.version
  // What Add pulls in besides this one — only the part still missing, since
  // naming siblings the user already has would read as a warning about nothing.
  const installedIds = new Set(controller.installed.items.map((i) => i.id))
  const missingDeps =
    item.state.kind === 'available'
      ? (item.entry?.dependsOn ?? []).filter((id) => !installedIds.has(id))
      : []
  const dependencyLine = missingDeps.length
    ? `Also adds ${missingDeps.map((id) => catalogById.get(id)?.name ?? id).join(', ')} — it hands work to them.`
    : null
  const meta = [
    extensionKindLabel(item.kind, true),
    item.by,
    item.localSkill
      ? item.localSkill.relativePath
      : item.projectRule
        ? item.projectRule.path
        : item.userRule
          ? null
          : version
            ? `${item.id}@${version}`
            : item.id
  ]
    .filter(Boolean)
    .join(' · ')
  const description =
    item.entry?.description ||
    item.installed?.description ||
    item.localSkill?.description ||
    item.projectRule?.description ||
    ''

  return (
    <aside
      aria-label={`${item.name} details`}
      data-extension-detail={item.key}
      className="scroll-thin w-[400px] shrink-0 overflow-y-auto border-l border-border px-5 py-5"
    >
      <div className="flex items-start gap-3">
        <BrandTile {...extensionTile(item, catalogById)} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-heading font-semibold text-fg-strong">{item.name}</h2>
            {item.entry?.verified ? (
              <Icon
                name="checkCircle"
                size={14}
                weight="fill"
                className="text-accent"
                role="img"
                aria-hidden={false}
                aria-label="Verified"
              />
            ) : null}
          </div>
          <div className="truncate text-xs text-muted" title={meta}>
            {meta}
          </div>
        </div>
      </div>
      {description ? (
        <p className="mt-3 text-sm leading-[21px] text-secondary">{description}</p>
      ) : null}

      {item.kind === 'mcp' ? (
        <McpBody
          item={item}
          controller={controller}
          settings={settings}
          contents={contents}
          dependencyLine={dependencyLine}
          confirm={confirm}
        />
      ) : item.localSkill ? (
        <LocalSkillBody item={item} controller={controller} workspaceName={workspaceName} confirm={confirm} onEdit={onEdit} />
      ) : item.userRule ? (
        <UserRuleBody rule={item.userRule} settings={settings} onUpdate={onUpdate} confirm={confirm} onEdit={onEdit} />
      ) : item.projectRule ? (
        <ProjectRuleBody item={item} controller={controller} workspaceName={workspaceName} confirm={confirm} onEdit={onEdit} />
      ) : (
        <PackageBody
          item={item}
          controller={controller}
          contents={contents}
          dependencyLine={dependencyLine}
          confirm={confirm}
        />
      )}
    </aside>
  )
}

/* ─── Shared pieces ──────────────────────────────────────────────────── */

function Detail({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className={SECTION_LABEL}>{label}</h3>
        {note ? <span className="text-xs text-tertiary">{note}</span> : null}
      </div>
      {children}
    </section>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex flex-wrap items-center gap-1.5">{children}</div>
}

function Status({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return (
    <p
      role={danger ? 'alert' : undefined}
      className={cn('mt-2 text-xs [overflow-wrap:anywhere]', danger ? 'text-danger' : 'text-muted')}
    >
      {children}
    </p>
  )
}

function Chip({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="inline-flex min-h-6 max-w-full items-start gap-1.5 rounded-md bg-surface px-2 py-1 font-mono text-caption text-secondary">
      <Icon name={icon} size={11} className="mt-px text-tertiary" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </span>
  )
}

function WhereControl({
  value,
  hasWorkspace,
  disabled,
  onChange
}: {
  value: WhereValue
  hasWorkspace: boolean
  disabled: boolean
  onChange: (next: WhereValue) => void
}) {
  return (
    <Segmented
      label="Where it can run"
      value={value}
      disabled={disabled}
      items={
        hasWorkspace
          ? [
              { id: 'all', label: 'All workspaces' },
              { id: 'this', label: 'This workspace' },
              { id: 'off', label: 'Off here' }
            ]
          : [
              { id: 'all', label: 'All workspaces' },
              { id: 'off', label: 'Off' }
            ]
      }
      onChange={onChange}
    />
  )
}

/** Global flag first, then this workspace's override — the order `wherePlan` returns. */
function useWhere(item: ExtensionItem, controller: MarketplaceController) {
  const hasWorkspace = controller.canOverrideWorkspace
  const apply = async (next: WhereValue): Promise<void> => {
    const scope = item.scope
    if (!scope) return
    const plan = wherePlan(scope, next, hasWorkspace)
    if (plan.global !== undefined) {
      const ok = item.installed
        ? await controller.setEnabled(item.installed, plan.global)
        : item.server
          ? await controller.setServerEnabled(item.server.id, plan.global)
          : false
      if (!ok) return
    }
    if (plan.override !== undefined) {
      await controller.setWorkspaceOverride(scope.overrideKind, scope.overrideId, plan.override)
    }
  }
  return { hasWorkspace, apply }
}

/** The catalog's own summary, for a package main cannot open (not bundled, not installed). */
function previewAsContents(entry: MarketplaceCatalogEntry | undefined): PackageContents | null {
  const preview = entry?.contentsPreview
  if (!entry || !preview) return null
  return {
    id: entry.id,
    kind: entry.kind,
    mcp: (preview.mcp ?? []).map((m) => ({ id: m.id, name: m.name, path: '' })),
    skills: (preview.skills ?? []).map((s) => ({ name: s.name, description: s.description ?? '', path: '' })),
    rules: (preview.rules ?? []).map((r) => ({ path: r.path }))
  }
}

/** What a package ships — read from disk for bundled and installed ones. */
function usePackageContents(item: ExtensionItem): PackageContents | null {
  const id = item.entry || item.installed ? item.id : null
  const version = item.installed?.version ?? item.entry?.version ?? ''
  const key = id ? `${id}@${version}` : null
  const entry = item.entry
  const [contents, setContents] = useState<{ key: string; data: PackageContents | null } | null>(null)
  useEffect(() => {
    if (!id || !window.vyotiq.marketplaceGetContents) return
    let cancelled = false
    const done = (data: PackageContents | null): void => {
      if (!cancelled) setContents({ key: `${id}@${version}`, data })
    }
    void window.vyotiq.marketplaceGetContents(id).then(
      (res) => done(res.ok ? res.data : previewAsContents(entry)),
      () => done(previewAsContents(entry))
    )
    return () => {
      cancelled = true
    }
  }, [id, version, entry])
  return contents && contents.key === key ? contents.data : null
}

async function removePackage(
  item: ExtensionItem,
  controller: MarketplaceController,
  confirm: ConfirmFn
): Promise<void> {
  const installed = item.installed
  if (!installed) return
  const ok = await confirm(
    installed.kind === 'skill'
      ? `Remove ${item.name}?`
      : `Remove ${item.name}? Stored sign-ins for its MCP servers are cleared.`,
    { title: `Remove ${item.name}`, confirmLabel: 'Remove', danger: true }
  )
  if (!ok) return
  // GitHub MCP shares the app's own GitHub sign-in, which pull requests use.
  const signOutGithub =
    installed.id === GITHUB_MCP_ID &&
    (await confirm(
      'Also sign out of GitHub? Pull requests in Agent V use the same sign-in. Cancel keeps GitHub signed in.',
      { title: 'Sign out of GitHub too?', confirmLabel: 'Sign out' }
    ))
  await controller.uninstall(installed, { signOutGithub })
}

/* ─── MCP servers ────────────────────────────────────────────────────── */

function signInLabel(serverId: string, auth: string | undefined): string {
  if (serverId === GITHUB_MCP_ID) return 'Sign in with GitHub'
  if (isGoogleMcpId(serverId)) return 'Sign in with Google'
  return auth === 'token' ? 'Add token' : 'Sign in'
}

function availableLine(entry: MarketplaceCatalogEntry | undefined): string {
  const auth = entry?.auth
  const first =
    auth === 'oauth' || auth === 'oauth-client'
      ? 'You sign in after adding it.'
      : auth === 'token'
        ? 'Needs a token after adding it.'
        : 'Connects on its own once added.'
  const requires = entry?.requires?.length ? ` Needs ${entry.requires.join(', ')} on this machine.` : ''
  return `${first}${requires}`
}

function McpBody({
  item,
  controller,
  settings,
  contents,
  dependencyLine,
  confirm
}: {
  item: ExtensionItem
  controller: MarketplaceController
  settings: Settings
  contents: PackageContents | null
  dependencyLine: string | null
  confirm: ConfirmFn
}) {
  const { state, server, status, entry, plugin } = item
  const serverId = server?.id ?? item.id
  const locked = controller.formLocked
  const [retrying, setRetrying] = useState(false)
  const [locating, setLocating] = useState(false)
  const [showAllTools, setShowAllTools] = useState(false)
  // Open while a failure is one the fields can fix, until the person decides.
  // Status lands after mount, so this cannot be settled once in an initializer.
  const [configToggled, setConfigToggled] = useState<boolean | null>(null)
  const configOpen =
    configToggled ?? (Boolean(status?.error) && !status?.missingBinary && status?.errorKind !== 'sign-in')
  const where = useWhere(item, controller)
  const installed = item.group !== 'discover'
  const manual = Boolean(server && server.source !== 'marketplace')

  const tools = useMemo(
    () =>
      (controller.toolCatalog?.entries ?? []).filter(
        (e) => e.source === 'mcp' && e.serverId === serverId
      ),
    [controller.toolCatalog, serverId]
  )
  const launch: McpLaunch | undefined = server ?? contents?.mcp[0]

  const locateBinary = async (): Promise<void> => {
    const binary = status?.missingBinary
    if (!binary || !server) return
    setLocating(true)
    try {
      // Main checks the pick is a runnable file before it comes back.
      const pick = await window.vyotiq.mcpPickBinary?.(binary)
      if (!pick?.ok) {
        pushToast(pick?.error ?? 'Could not open the file picker.', 'error')
        return
      }
      if (!pick.data.path) return
      if (await controller.updateServer({ ...server, binaryPath: pick.data.path })) {
        await controller.loadMcpStatus('failed')
      }
    } finally {
      setLocating(false)
    }
  }

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      await controller.loadMcpStatus('failed')
    } finally {
      setRetrying(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (item.installed) {
      await removePackage(item, controller, confirm)
      return
    }
    if (!manual || !server) return
    const ok = await confirm(`Remove ${item.name}? Its stored token is cleared too.`, {
      title: `Remove ${item.name}`,
      confirmLabel: 'Remove',
      danger: true
    })
    if (ok) await controller.removeServer(server.id)
  }

  const canRemove = Boolean(item.installed) || manual
  const removeButton = canRemove ? (
    <Button size="sm" variant="ghost" disabled={locked} onClick={() => void remove()}>
      Remove
    </Button>
  ) : null
  const connectable = server ? mcpSupportsOAuth(server) || mcpUsesTokenAuth(server) : false

  let actions: ReactNode = removeButton
  let statusLine: ReactNode = null
  let danger = false
  switch (state.kind) {
    case 'available':
      actions = entry ? (
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          pending={controller.busyTargetId === entry.id}
          disabled={locked}
          onClick={() => void controller.installFromCatalog(entry)}
        >
          Add
        </Button>
      ) : null
      statusLine = dependencyLine ? `${availableLine(entry)} ${dependencyLine}` : availableLine(entry)
      break
    case 'soon':
      actions = null
      statusLine = 'Not available to install yet.'
      break
    case 'signin':
      actions = (
        <>
          <Button
            size="sm"
            variant="primary"
            icon="key"
            disabled={locked}
            onClick={() => controller.openConnectWizard(serverId)}
          >
            {signInLabel(serverId, server?.auth ?? entry?.auth)}
          </Button>
          {removeButton}
        </>
      )
      statusLine = 'Installed, not connected — sign in to use its tools.'
      break
    case 'binary':
      actions = (
        <>
          {status?.missingBinaryInstallUrl ? (
            <Button
              size="sm"
              variant="primary"
              icon="external"
              disabled={locked}
              onClick={() => void window.vyotiq.shellOpenExternal(status.missingBinaryInstallUrl as string)}
            >
              Install {state.binary}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={status?.missingBinaryInstallUrl ? 'ghost' : 'primary'}
            icon="folderOpen"
            pending={locating}
            disabled={locked || !server}
            onClick={() => void locateBinary()}
          >
            Locate binary…
          </Button>
          {/* Main clears its binary cache first, so this finds one installed a moment ago. */}
          <Button size="sm" variant="ghost" icon="retry" pending={retrying} disabled={locked} onClick={() => void retry()}>
            Retry
          </Button>
          {removeButton}
        </>
      )
      statusLine = (
        <>
          <span className="font-mono">{state.binary}</span> was not found on PATH, so this server
          cannot start.
          {server?.binaryPath ? ` Using ${server.binaryPath}.` : ''}
        </>
      )
      break
    case 'failed':
    case 'not-connected':
      actions = (
        <>
          <Button
            size="sm"
            variant="primary"
            icon="retry"
            pending={retrying}
            disabled={locked}
            onClick={() => void retry()}
          >
            Retry
          </Button>
          {removeButton}
        </>
      )
      statusLine = state.kind === 'failed' ? (status?.error ?? 'Connection failed.') : 'Enabled, not connected.'
      danger = state.kind === 'failed'
      break
    case 'connecting':
      statusLine = 'Connecting…'
      break
    case 'connected':
      actions = (
        <>
          {connectable ? (
            <Button
              size="sm"
              variant="secondary"
              icon="key"
              disabled={locked}
              onClick={() => controller.openConnectWizard(serverId)}
            >
              Reconnect
            </Button>
          ) : null}
          {removeButton}
        </>
      )
      statusLine = `Connected — ${state.tools} tool${state.tools === 1 ? '' : 's'}.`
      break
    case 'off':
      statusLine =
        plugin && !item.scope ? `Off — ${plugin.name} is off.` : 'Off in every workspace.'
      break
    case 'off-here':
      statusLine = 'Off in this workspace.'
      break
    default:
      statusLine = controller.mcpStatusLoaded ? 'Installed.' : 'Checking the connection…'
  }

  const nestedOverride =
    plugin && !item.scope && server
      ? workspaceOverrideForId(controller.workspaceOverrides, 'mcp', server.id)
      : undefined

  return (
    <>
      {actions ? <Actions>{actions}</Actions> : null}
      {statusLine ? <Status danger={danger}>{statusLine}</Status> : null}

      {item.scope ? (
        <Detail label="Where it can run">
          <WhereControl
            value={whereValue(item.scope)}
            hasWorkspace={where.hasWorkspace}
            disabled={locked}
            onChange={(next) => void where.apply(next)}
          />
        </Detail>
      ) : plugin && server ? (
        <Detail label="Where it can run" note={`follows ${plugin.name}`}>
          {where.hasWorkspace ? (
            <Segmented
              label="Where it can run"
              value={nestedOverride === false ? 'off' : 'all'}
              disabled={locked}
              items={[
                { id: 'all', label: `With ${plugin.name}` },
                { id: 'off', label: 'Off here' }
              ]}
              onChange={(next) =>
                void controller.setWorkspaceOverride('mcp', server.id, next === 'off' ? false : null)
              }
            />
          ) : (
            <p className="text-xs text-muted">Runs wherever {plugin.name} runs.</p>
          )}
        </Detail>
      ) : null}

      {installed ? (
        <Detail
          label="Tools"
          note={
            tools.length > TOOLS_SHOWN && !showAllTools
              ? `${tools.length} · ${TOOLS_SHOWN} shown`
              : tools.length > 0
                ? String(tools.length)
                : undefined
          }
        >
          {tools.length > 0 ? (
            <>
              <ul className="divide-y divide-border border-y border-border">
                {(showAllTools ? tools : tools.slice(0, TOOLS_SHOWN)).map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
              {tools.length > TOOLS_SHOWN ? (
                <button
                  type="button"
                  className="mt-2 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
                  onClick={() => setShowAllTools((v) => !v)}
                >
                  {showAllTools ? `Show ${TOOLS_SHOWN}` : `Show all ${tools.length}`}
                </button>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted">
              {state.kind === 'connected'
                ? 'It lists no tools.'
                : state.kind === 'off' || state.kind === 'off-here'
                  ? 'Its tools load when it is on.'
                  : 'Tools appear once it connects.'}
            </p>
          )}
        </Detail>
      ) : null}

      {launch ? <LaunchDetail launch={launch} binaryPath={server?.binaryPath} /> : null}

      {server ? (
        <section className="mt-6">
          <button
            type="button"
            aria-expanded={configOpen}
            aria-controls={`mcp-config-${server.id}`}
            className={cn(
              'flex items-center gap-1.5 rounded-sm hover:text-fg focus-visible:vy-focus-ring',
              SECTION_LABEL
            )}
            onClick={() => setConfigToggled(!configOpen)}
          >
            <Icon name={configOpen ? 'chevron' : 'chevronRight'} size={11} />
            Configuration
          </button>
          <div id={`mcp-config-${server.id}`} hidden={!configOpen} className="mt-3">
            {configOpen ? (
              <McpServerConfig
                server={server}
                status={status}
                disabled={locked}
                googleMcpClientId={settings.googleMcpClientId}
                onUpdate={controller.updateServer}
                onAuthChanged={() => void controller.loadMcpStatus(false)}
              />
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  )
}

function ToolRow({ tool }: { tool: ToolCatalogEntry }) {
  const bare = tool.name.split('__').pop() ?? tool.name
  const inactive = !tool.active && tool.reason ? INACTIVE_REASON[tool.reason] : null
  return (
    <li className="flex h-8 items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg" title={tool.description || bare}>
        {bare}
      </span>
      {inactive ? (
        <span className="text-caption text-tertiary">{inactive}</span>
      ) : tool.readOnlyHint ? (
        <span className="text-caption text-tertiary" title="The server declares it read-only">
          reads
        </span>
      ) : (
        <span className="text-caption text-warning" title="The server does not declare it read-only">
          may write
        </span>
      )}
    </li>
  )
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/** Where a remote server calls, or what a local one runs — the parts that are known. */
function LaunchDetail({ launch, binaryPath }: { launch: McpLaunch; binaryPath?: string }) {
  if ((launch.transport ?? 'stdio') !== 'stdio') {
    const host = hostOf(launch.url)
    if (!host) return null
    return (
      <Detail label="Reaches">
        <div className="flex flex-wrap gap-1.5">
          <Chip icon="globe">{host}</Chip>
        </div>
      </Detail>
    )
  }
  const line = mcpLaunchLine(launch)
  if (!line) return null
  return (
    <Detail label="Runs">
      <div className="flex flex-wrap gap-1.5">
        <Chip icon="terminal">{line}</Chip>
        {binaryPath ? <Chip icon="folder">{binaryPath}</Chip> : null}
      </div>
    </Detail>
  )
}

/* ─── Catalog skills and packages ────────────────────────────────────── */

function PackageBody({
  item,
  controller,
  contents,
  dependencyLine,
  confirm
}: {
  item: ExtensionItem
  controller: MarketplaceController
  contents: PackageContents | null
  dependencyLine: string | null
  confirm: ConfirmFn
}) {
  const { state, entry } = item
  const locked = controller.formLocked
  const where = useWhere(item, controller)
  const rows = contents
    ? [
        ...contents.mcp.map((m) => ({ key: `mcp:${m.id}`, icon: 'mcp' as const, name: m.name, kind: 'MCP' })),
        ...contents.skills.map((s) => ({ key: `skill:${s.name}`, icon: 'skill' as const, name: s.name, kind: 'Skill' })),
        ...contents.rules.map((r) => ({ key: `rule:${r.path}`, icon: 'rules' as const, name: r.path, kind: 'Rule' }))
      ]
    : []
  return (
    <>
      {state.kind === 'available' && entry ? (
        <Actions>
          <Button
            size="sm"
            variant="primary"
            icon="plus"
            pending={controller.busyTargetId === entry.id}
            disabled={locked}
            onClick={() => void controller.installFromCatalog(entry)}
          >
            Add
          </Button>
        </Actions>
      ) : item.installed ? (
        <Actions>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => void removePackage(item, controller, confirm)}>
            Remove
          </Button>
        </Actions>
      ) : null}
      {state.kind === 'soon' ? (
        <Status>Not available to install yet.</Status>
      ) : dependencyLine ? (
        <Status>{dependencyLine}</Status>
      ) : null}

      {item.scope ? (
        <Detail label="Where it can run">
          <WhereControl
            value={whereValue(item.scope)}
            hasWorkspace={where.hasWorkspace}
            disabled={locked}
            onChange={(next) => void where.apply(next)}
          />
        </Detail>
      ) : null}

      {item.kind === 'package' && rows.length > 0 ? (
        <Detail label="Contains" note={String(rows.length)}>
          <ul className="divide-y divide-border border-y border-border">
            {rows.map((row) => (
              <li key={row.key} className="flex h-8 items-center gap-2 text-xs">
                <Icon name={row.icon} size={13} className="text-tertiary" />
                <span className="min-w-0 flex-1 truncate text-fg">{row.name}</span>
                <span className="text-caption text-tertiary">{row.kind}</span>
              </li>
            ))}
          </ul>
        </Detail>
      ) : null}
    </>
  )
}

/* ─── Skill files ────────────────────────────────────────────────────── */

function LocalSkillBody({
  item,
  controller,
  workspaceName,
  confirm,
  onEdit
}: {
  item: ExtensionItem
  controller: MarketplaceController
  workspaceName: string | null
  confirm: ConfirmFn
  onEdit: (target: EditorTarget) => void
}) {
  const skill = item.localSkill
  if (!skill) return null
  const workspacePath = controller.workspacePath
  const project = skill.source === 'project'

  const openExternally = async (): Promise<void> => {
    const res = await window.vyotiq.skillsOpenLocal({ workspacePath, skillPath: skill.skillPath })
    if (!res.ok) pushToast(res.error, 'error')
  }
  const reveal = async (): Promise<void> => {
    if (!workspacePath) return
    const res = await window.vyotiq.workspaceFileReveal({ workspacePath, path: skill.relativePath })
    if (!res.ok) pushToast(res.error, 'error')
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm(`Delete skill “${skill.name}”? This cannot be undone.`, {
      title: 'Delete skill',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await window.vyotiq.skillsDeleteLocal({ workspacePath, skillPath: skill.skillPath })
    if (!res.ok) pushToast(res.error, 'error')
    else pushToast(`Deleted ${skill.name}.`, 'success')
  }

  const from = skill.origin === 'cursor' ? ' Read from .cursor/skills.' : ''
  return (
    <>
      <Actions>
        <Button size="sm" variant="primary" icon="edit" onClick={() => onEdit({ kind: 'skill', skillPath: skill.skillPath })}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void openExternally()}>
          Open externally
        </Button>
        {project && workspacePath ? (
          <Button size="sm" variant="ghost" onClick={() => void reveal()}>
            Reveal
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => void remove()}>
          Delete
        </Button>
      </Actions>
      <Status>
        {project ? `In ${workspaceName ?? 'this workspace'} only.` : 'Yours — in every workspace.'}
        {from}
      </Status>
    </>
  )
}

/* ─── Rules ──────────────────────────────────────────────────────────── */

function UserRuleBody({
  rule,
  settings,
  onUpdate,
  confirm,
  onEdit
}: {
  rule: UserRule
  settings: Settings
  onUpdate: (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>
  confirm: ConfirmFn
  onEdit: (target: EditorTarget) => void
}) {
  const [saving, setSaving] = useState(false)
  const rules = settings.userRules ?? []
  const save = async (next: UserRule[]): Promise<void> => {
    setSaving(true)
    try {
      const res = await onUpdate({ userRules: next })
      if (!res.ok) pushToast(res.error, 'error')
    } finally {
      setSaving(false)
    }
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm(`Delete user rule “${rule.name}”? This cannot be undone.`, {
      title: 'Delete user rule',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok) await save(rules.filter((r) => r.id !== rule.id))
  }
  const empty = !rule.body.trim()
  return (
    <>
      <Actions>
        <Button size="sm" variant="primary" icon="edit" onClick={() => onEdit({ kind: 'user-rule', ruleId: rule.id })}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => void remove()}>
          Delete
        </Button>
      </Actions>
      <Status>
        {!rule.enabled
          ? 'Off — not added to any chat.'
          : empty
            ? 'Not applied — it has no text yet.'
            : 'Added to every chat.'}
      </Status>
      <Detail label="Where it can run">
        <WhereControl
          value={rule.enabled ? 'all' : 'off'}
          hasWorkspace={false}
          disabled={saving}
          onChange={(next) =>
            void save(rules.map((r) => (r.id === rule.id ? { ...r, enabled: next !== 'off' } : r)))
          }
        />
      </Detail>
    </>
  )
}

function ProjectRuleBody({
  item,
  controller,
  workspaceName,
  confirm,
  onEdit
}: {
  item: ExtensionItem
  controller: MarketplaceController
  workspaceName: string | null
  confirm: ConfirmFn
  onEdit: (target: EditorTarget) => void
}) {
  const rule = item.projectRule
  const workspacePath = controller.workspacePath
  if (!rule) return null
  const root = isRootRulePath(rule.path)
  const applies = item.state.kind === 'rule' ? item.state.applies : 'always'
  const where = workspaceName ?? 'this workspace'

  const openExternally = async (): Promise<void> => {
    if (!workspacePath) return
    const res = await window.vyotiq.slashCommandsOpenFile({ workspacePath, path: rule.path })
    if (!res.ok) pushToast(res.error, 'error')
  }
  const remove = async (): Promise<void> => {
    if (!workspacePath) return
    const ok = await confirm(`Delete project rule “${rule.path}”? This cannot be undone.`, {
      title: 'Delete project rule',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await window.vyotiq.workspaceFileDelete({ workspacePath, path: rule.path, recursive: false })
    if (!res.ok) {
      pushToast(res.error, 'error')
      return
    }
    await controller.loadProjectRules()
  }

  return (
    <>
      <Actions>
        <Button
          size="sm"
          variant="primary"
          icon="edit"
          disabled={!workspacePath}
          onClick={() => onEdit({ kind: 'project-rule', path: rule.path })}
        >
          Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={!workspacePath} onClick={() => void openExternally()}>
          Open externally
        </Button>
        {root ? null : (
          <Button size="sm" variant="ghost" disabled={!workspacePath} onClick={() => void remove()}>
            Delete
          </Button>
        )}
      </Actions>
      <Status>
        {root
          ? `A root instruction file — added to every chat in ${where}.`
          : applies === 'matching'
            ? `Added in ${where} while a file matching its globs is open.`
            : applies === 'request'
              ? 'Added when you @-mention it.'
              : `Added to every chat in ${where}.`}
      </Status>
    </>
  )
}
