import { useId } from 'react'
import { DEFAULT_SKIN_ID, SKIN_CATALOG, type SkinId } from '@shared/skins'
import { cn, useFormChange } from '@renderer/lib/ui'
import type { SettingMark } from '../hooks/useSettingsForm'

/**
 * The five skins as miniatures of themselves: each half renders under that
 * skin's own `data-skin` / `data-theme` tokens, light on the left and dark on
 * the right, so the card is the skin rather than a swatch standing in for it.
 */
export function SkinPicker({
  value,
  disabled,
  mark,
  onChange
}: {
  value: SkinId
  disabled?: boolean
  mark: SettingMark
  onChange: (skin: SkinId) => void
}) {
  // A block, not a row, so it reports its change itself.
  useFormChange(mark.changed, mark.onReset, mark.resetTo)
  const baseId = useId()
  return (
    <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
      {SKIN_CATALOG.map((skin) => {
        const on = skin.id === value
        const lineId = `${baseId}-${skin.id}`
        return (
          <button
            key={skin.id}
            type="button"
            aria-pressed={on}
            aria-label={skin.label}
            aria-describedby={lineId}
            disabled={disabled}
            data-skin-option={skin.id}
            className="group self-start rounded-lg text-left focus-visible:vy-focus-ring disabled:vy-disabled-state"
            onClick={() => {
              if (!on) onChange(skin.id)
            }}
          >
            <div
              className={cn(
                'overflow-hidden rounded-lg border vy-transition',
                on ? 'border-accent ring-2 ring-accent-soft' : 'border-border group-hover:border-border-strong'
              )}
            >
              <div className="grid grid-cols-2" aria-hidden="true">
                {(['light', 'dark'] as const).map((theme) => (
                  <div key={theme} data-skin={skin.id} data-theme={theme} className="flex h-[72px] bg-chrome">
                    <div className="flex w-5 flex-col gap-1 p-1.5 pt-2">
                      <span className="h-1 w-full rounded-full bg-accent" />
                      <span className="h-1 w-full rounded-full bg-border-strong" />
                      <span className="h-1 w-full rounded-full bg-border-strong" />
                    </div>
                    <div className="vy-panel flex-1 p-2">
                      <span className="block h-1 w-3/4 rounded-full bg-fg" />
                      <span className="mt-1 block h-1 w-1/2 rounded-full bg-muted" />
                      <span className="mt-2 block h-2.5 w-7 rounded-sm bg-accent" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className={cn('text-sm', on ? 'font-medium text-fg-strong' : 'text-fg')}>{skin.label}</span>
              {skin.id === DEFAULT_SKIN_ID ? <span className="text-caption text-tertiary">default</span> : null}
            </div>
            <div id={lineId} className="text-xs text-muted">
              {skin.description}
            </div>
          </button>
        )
      })}
    </div>
  )
}
