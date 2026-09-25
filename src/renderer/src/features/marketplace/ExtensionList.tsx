import type { MarketplaceCatalogEntry } from '@shared/ipc'
import type { IconName } from '@renderer/lib/icons'
import { Button, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SECTION_LABEL, SELECTED } from '@renderer/lib/utils/layout'
import { BrandTile } from './BrandTile'
import {
  extensionKindLabel,
  extensionStateLabel,
  type ExtensionItem,
  type ExtensionSection,
  type ExtensionState
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
  onSelect,
  onAdd
}: {
  sections: readonly ExtensionSection[]
  selectedKey: string | null
  catalogById: ReadonlyMap<string, MarketplaceCatalogEntry>
  /** The catalog id being added right now. */
  addingId: string | null
  disabled: boolean
  onSelect: (key: string) => void
  onAdd: (item: ExtensionItem) => void
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
          <ul className="divide-y divide-border border-y border-border">
            {section.items.map((item) => (
              <ExtensionRow
                key={item.key}
                item={item}
                tile={extensionTile(item, catalogById)}
                selected={item.key === selectedKey}
                adding={addingId != null && item.entry?.id === addingId}
                disabled={disabled}
                onSelect={onSelect}
                onAdd={onAdd}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function ExtensionRow({
  item,
  tile,
  selected,
  adding,
  disabled,
  onSelect,
  onAdd
}: {
  item: ExtensionItem
  tile: TileProps
  selected: boolean
  adding: boolean
  disabled: boolean
  onSelect: (key: string) => void
  onAdd: (item: ExtensionItem) => void
}) {
  // Add is its own button, so it sits beside the row's button rather than in it.
  const addable = item.state.kind === 'available'
  return (
    <li
      data-extension-key={item.key}
      className={cn('-mx-2 flex items-center rounded-md', selected ? SELECTED : ROW_HOVER)}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(item.key)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-md py-2.5 text-left focus-visible:vy-focus-ring',
          addable ? 'pl-2' : 'px-2'
        )}
      >
        <BrandTile {...tile} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-fg-strong" title={item.name}>
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
        {addable ? null : <RowState state={item.state} />}
      </button>
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
