import { useState } from 'react'
import type { MarketplaceCatalogEntry, MarketplaceOverrides } from '@shared/ipc'
import type { IconName } from '@renderer/lib/icons'
import { ActionMenu, Button, IconButton, Switch, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SECTION_LABEL, SELECTED } from '@renderer/lib/utils/layout'
import { BrandTile } from './BrandTile'
import {
  extensionKindLabel,
  extensionStateLabel,
  extensionSwitch,
  rowStateShown,
  scopedToWorkspace,
  whereValue,
  type ExtensionItem,
  type ExtensionSection,
  type ExtensionState,
  type WhereValue
} from './extensionItems'

export type TileProps = { name: string; iconUrl?: string; iconMono?: boolean; icon?: IconName }

/**
 * The art a row shows: its catalog entry's, or for a server shipped inside a
 * package, that package's. Rules have no art of their own.
 */
export function extensionTile(
  item: ExtensionItem,
  catalogById: ReadonlyMap<string, MarketplaceCatalogEntry>
): TileProps {
  const entry = item.entry ?? (item.plugin ? catalogById.get(item.plugin.id) : undefined)
  return {
    name: item.name,
    ...(entry?.iconUrl ? { iconUrl: entry.iconUrl, iconMono: entry.iconMono } : {}),
    ...(item.kind === 'rule' ? { icon: 'rules' as const } : {})
  }
}

export function ExtensionList({
  sections,
  selectedKey,
  catalogById,
  addingId,
  disabled,
  hasWorkspace,
  overrides,
  onSelect,
  onAdd,
  onSwitch,
  onWhere,
  onSignIn
}: {
  sections: readonly ExtensionSection[]
  selectedKey: string | null
  catalogById: ReadonlyMap<string, MarketplaceCatalogEntry>
  /** The catalog id being added right now. */
  addingId: string | null
  disabled: boolean
  /** A workspace is open that can override the global flags. */
  hasWorkspace: boolean
  /** That workspace's Force on/off map. */
  overrides: MarketplaceOverrides | null
  onSelect: (key: string) => void
  onAdd: (item: ExtensionItem) => void
  onSwitch: (item: ExtensionItem, on: boolean) => void
  onWhere: (item: ExtensionItem, next: WhereValue) => void
  onSignIn: (item: ExtensionItem) => void
}) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.group} className="mt-5" aria-labelledby={`extensions-${section.group}`}>
          <h2
            id={`extensions-${section.group}`}
            className={cn('mb-1 flex items-center gap-2', SECTION_LABEL)}
          >
            {section.label}
            <span className="font-mono font-normal tnum">{section.items.length}</span>
          </h2>
          <ul className="divide-y divide-border/60 border-y border-border">
            {section.items.map((item) => (
              <ExtensionRow
                key={item.key}
                item={item}
                tile={extensionTile(item, catalogById)}
                selected={item.key === selectedKey}
                adding={addingId != null && item.entry?.id === addingId}
                disabled={disabled}
                rowSwitch={extensionSwitch(item, { hasWorkspace, overrides })}
                hasWorkspace={hasWorkspace}
                onSelect={onSelect}
                onAdd={onAdd}
                onSwitch={onSwitch}
                onWhere={onWhere}
                onSignIn={onSignIn}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

const WHERE_CHOICES: readonly { id: WhereValue; label: string }[] = [
  { id: 'all', label: 'All workspaces' },
  { id: 'this', label: 'This workspace only' },
  { id: 'off', label: 'Off here' }
]

function ExtensionRow({
  item,
  tile,
  selected,
  adding,
  disabled,
  rowSwitch,
  hasWorkspace,
  onSelect,
  onAdd,
  onSwitch,
  onWhere,
  onSignIn
}: {
  item: ExtensionItem
  tile: TileProps
  selected: boolean
  adding: boolean
  disabled: boolean
  rowSwitch: { on: boolean; locked: boolean } | null
  hasWorkspace: boolean
  onSelect: (key: string) => void
  onAdd: (item: ExtensionItem) => void
  onSwitch: (item: ExtensionItem, on: boolean) => void
  onWhere: (item: ExtensionItem, next: WhereValue) => void
  onSignIn: (item: ExtensionItem) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  // Add, Sign in, the switch and the ⋯ menu are buttons of their own, so they
  // sit beside the row's button rather than in it.
  const addable = item.state.kind === 'available'
  const signIn = item.state.kind === 'signin'
  const control = signIn || rowSwitch != null
  // "This workspace only" is the one choice a switch cannot say.
  const scope = hasWorkspace && control ? item.scope : undefined
  const where = scope ? whereValue(scope) : null
  return (
    <li
      data-extension-key={item.key}
      className={cn('group -mx-2 flex items-center rounded-md', selected ? SELECTED : ROW_HOVER)}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(item.key)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-md py-2.5 text-left focus-visible:vy-focus-ring',
          addable || control ? 'pl-2' : 'px-2'
        )}
      >
        <BrandTile {...tile} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {/* Switched off, the name goes quiet: what is on is what you read first. */}
            <span
              className={cn('truncate text-sm font-medium', rowSwitch && !rowSwitch.on ? 'text-muted' : 'text-fg-strong')}
              title={item.name}
            >
              {item.name}
            </span>
            <span className="shrink-0 text-caption text-tertiary">
              {extensionKindLabel(item.kind)} · {item.by}
            </span>
          </span>
          <span className="block truncate text-xs text-muted" title={item.line || undefined}>
            {item.line}
          </span>
        </span>
        {rowStateShown(item, rowSwitch != null) ? <RowState state={item.state} /> : null}
        {scopedToWorkspace(item, hasWorkspace) ? (
          <span className="shrink-0 text-xs text-muted">this workspace</span>
        ) : null}
      </button>
      {control ? (
        <span className="flex shrink-0 items-center gap-2 pl-3 pr-2">
          {scope && where ? (
            // Shown on hover or focus, but it keeps its width so every switch
            // ends on the same edge.
            <span className={menuOpen ? 'visible' : 'invisible group-hover:visible group-focus-within:visible'}>
              <ActionMenu
                aria-label={`Where ${item.name} can run`}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                placement="down"
                align="end"
                items={WHERE_CHOICES.map((choice) => ({
                  id: choice.id,
                  label: choice.label,
                  checked: where === choice.id,
                  disabled,
                  onSelect: () => {
                    if (where !== choice.id) onWhere(item, choice.id)
                  }
                }))}
                trigger={(t) => (
                  <IconButton
                    ref={t.ref}
                    icon="more"
                    label={`Where ${item.name} can run`}
                    // An open menu would sit under its own tooltip.
                    title={menuOpen ? '' : undefined}
                    size="xs"
                    tone="onSurface"
                    aria-expanded={t['aria-expanded']}
                    aria-controls={t['aria-controls']}
                    aria-haspopup={t['aria-haspopup']}
                    onClick={t.onClick}
                  />
                )}
              />
            </span>
          ) : (
            <span aria-hidden="true" className="w-5" />
          )}
          {signIn ? (
            <Button
              size="xs"
              variant="primary"
              aria-label={`Sign in to ${item.name}`}
              disabled={disabled}
              onClick={() => onSignIn(item)}
            >
              Sign in
            </Button>
          ) : rowSwitch ? (
            <Switch
              checked={rowSwitch.on}
              disabled={disabled || rowSwitch.locked}
              label={`Enable ${item.name}`}
              onCheckedChange={(on) => onSwitch(item, on)}
            />
          ) : null}
        </span>
      ) : null}
      {addable ? (
        <span className="shrink-0 pl-3 pr-2">
          <Button
            size="xs"
            variant="ghost"
            icon="plus"
            aria-label={`Add ${item.name}`}
            pending={adding}
            disabled={disabled}
            onClick={() => onAdd(item)}
          >
            Add
          </Button>
        </span>
      ) : null}
    </li>
  )
}

/** What a row says on its right edge. Only the states that want you are coloured. */
export function RowState({ state }: { state: ExtensionState }) {
  const label = extensionStateLabel(state)
  switch (state.kind) {
    case 'signin':
    case 'binary':
    case 'not-connected':
      return <span className="shrink-0 text-xs font-medium text-accent">{label}</span>
    case 'failed':
      return <span className="shrink-0 text-xs font-medium text-danger">{label}</span>
    case 'connected':
      return (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
          {label}
        </span>
      )
    case 'connecting':
      return <span className="shrink-0 text-xs text-muted">{label}</span>
    default:
      return <span className="shrink-0 text-xs text-tertiary">{label}</span>
  }
}
