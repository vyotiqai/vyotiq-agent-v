import type { FontScale, UiDensity } from '@shared/appearance'
import type { SkinId } from '@shared/skins'
import { SKIN_CATALOG } from '@shared/skins'
import type { Settings, ThemeId } from '@shared/ipc'
import { Button, cn } from '@renderer/lib/ui'
import { Menu } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  DENSITY_OPTIONS,
  FONT_SCALE_OPTIONS,
  THEME_OPTIONS
} from '../constants'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

export function AppearanceSection({
  settings,
  form,
  onAppearanceChange,
  customCssError = null
}: {
  settings: Settings
  form: SettingsFormState
  onAppearanceChange?: SettingsViewProps['onAppearanceChange']
  customCssError?: string | null
}) {

  const apply = (partial: Partial<{
    theme: ThemeId
    fontScale: FontScale
    uiDensity: UiDensity
    skinId: SkinId
    customCssPath: string
  }>): void => {
    form.clearErrors()
    onAppearanceChange?.(partial)
  }

  const pickCustomCss = async (): Promise<void> => {
    if (!window.vyotiq?.appearancePickCustomCss) return
    const res = await window.vyotiq.appearancePickCustomCss()
    if (res.ok && res.data) apply({ customCssPath: res.data })
  }

  const clearCustomCss = (): void => {
    apply({ customCssPath: '' })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Skin">
        <SettingsField
          id="appearance-skin"
          title="Interface skin"
          hint="Task-focused looks — contrast, elevation, or fonts."
          help="Default matches the shipped instrument. Proof, Bench, and Native change contrast, elevation, or fonts."
          wide
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SKIN_CATALOG.map((skin) => {
              const selected = settings.skinId === skin.id
              return (
                <button
                  key={skin.id}
                  type="button"
                  disabled={form.formLocked || !onAppearanceChange}
                  aria-pressed={selected}
                  aria-label={skin.label}
                  onClick={() => apply({ skinId: skin.id })}
                  className={cn(
                    'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm vy-transition',
                    selected
                      ? 'border-fg bg-surface text-fg-strong ring-1 ring-inset ring-border-strong'
                      : 'border-border text-fg hover:bg-surface/50'
                  )}
                >
                  <span
                    className="size-6 shrink-0 rounded-md border border-border"
                    style={skin.previewStyle}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="block font-medium leading-tight">{skin.label}</span>
                    <span className="block text-caption text-muted">{skin.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Theme">
        <SettingsField
          id="appearance-theme"
          title="Color mode"
          hint="Window chrome and interface colors."
          help="System follows the OS light/dark preference. Dark and Light pin the theme."
        >
          <Menu
            aria-label="Theme"
            value={settings.theme}
            options={THEME_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ theme: v as ThemeId })}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Text & layout">
        <SettingsField
          id="appearance-font-scale"
          title="Text size"
          hint="Scales body copy and UI labels."
          help="Small and Large adjust the type scale app-wide. Default matches the designed size."
        >
          <Menu
            aria-label="Text size"
            value={settings.fontScale}
            options={FONT_SCALE_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ fontScale: v as FontScale })}
          />
        </SettingsField>

        <SettingsField
          id="appearance-density"
          title="UI density"
          hint="Control padding and tap targets."
          help="Compact tightens buttons and fields. Comfortable adds more spacing."
        >
          <Menu
            aria-label="UI density"
            value={settings.uiDensity}
            options={DENSITY_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !onAppearanceChange}
            onChange={(v) => apply({ uiDensity: v as UiDensity })}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Custom CSS">
        <SettingsField
          id="appearance-custom-css"
          title="User CSS overlay"
          hint="Local stylesheet on top of the selected skin."
          help="Overrides --vy-* tokens after the skin applies. Remote @import URLs are stripped. Max 256KB."
          wide
        >
          <div className="flex flex-col gap-2">
            <p className="m-0 text-caption text-muted break-all">
              {settings.customCssPath ? settings.customCssPath : 'No file selected'}
            </p>
            {customCssError ? (
              <p className="m-0 text-caption text-danger">{customCssError}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="subtle"
                disabled={form.formLocked || !onAppearanceChange}
                onClick={() => void pickCustomCss()}
              >
                Choose CSS…
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={form.formLocked || !onAppearanceChange || !settings.customCssPath}
                onClick={clearCustomCss}
              >
                Clear
              </Button>
            </div>
          </div>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
