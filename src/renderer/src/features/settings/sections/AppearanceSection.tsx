import type { FontScale, UiDensity } from '@shared/appearance'
import type { SkinId } from '@shared/skins'
import { SKIN_CATALOG } from '@shared/skins'
import type { ThemeId } from '@shared/ipc'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { DENSITY_OPTIONS, FONT_SCALE_OPTIONS, THEME_OPTIONS } from '../constants'
import { ChoiceCards } from '../components/ChoiceCards'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

const SKIN_OPTIONS = SKIN_CATALOG.map((skin) => ({
  value: skin.id,
  label: skin.label,
  description: skin.description,
  swatchStyle: skin.previewStyle
}))

export function AppearanceSection({
  form,
  onAppearanceChange,
  customCssError = null
}: {
  form: SettingsFormState
  onAppearanceChange?: SettingsViewProps['onAppearanceChange']
  customCssError?: string | null
}) {
  const settings = form.settings
  const locked = form.formLocked || !onAppearanceChange

  const apply = (
    partial: Partial<{
      theme: ThemeId
      fontScale: FontScale
      uiDensity: UiDensity
      skinId: SkinId
      customCssPath: string
    }>
  ): void => {
    form.clearErrors()
    onAppearanceChange?.(partial)
  }

  const pickCustomCss = async (): Promise<void> => {
    if (!window.vyotiq?.appearancePickCustomCss) return
    const res = await window.vyotiq.appearancePickCustomCss()
    if (res.ok && res.data) apply({ customCssPath: res.data })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Theme">
        <SettingsField
          id="appearance-skin"
          title="Interface skin"
          hint="Contrast, elevation, and type for the whole app."
          help="Default is the Azure instrument look. Proof is dusk, Bench neon blue, Gild blue-slate on alabaster and onyx, and Native uses system fonts with an orange accent."
          wide
        >
          <ChoiceCards
            label="Interface skin"
            value={settings.skinId}
            options={SKIN_OPTIONS}
            columns="grid"
            disabled={locked}
            onChange={(value) => apply({ skinId: value as SkinId })}
          />
        </SettingsField>
        <SelectField
          id="appearance-theme"
          title="Color mode"
          hint="Light, dark, or follow the system."
          value={settings.theme}
          options={THEME_OPTIONS}
          disabled={locked}
          onChange={(theme) => apply({ theme })}
        />
      </SettingsGroup>

      <SettingsGroup title="Text & spacing">
        <SelectField
          id="appearance-font-scale"
          title="Text size"
          hint="Scales body copy and UI labels."
          value={settings.fontScale}
          options={FONT_SCALE_OPTIONS}
          disabled={locked}
          onChange={(fontScale) => apply({ fontScale })}
        />
        <SelectField
          id="appearance-density"
          title="UI density"
          hint="Padding and target size of controls."
          value={settings.uiDensity}
          options={DENSITY_OPTIONS}
          disabled={locked}
          onChange={(uiDensity) => apply({ uiDensity })}
        />
      </SettingsGroup>

      <SettingsGroup title="Custom CSS">
        <SettingsField
          id="appearance-custom-css"
          title="User CSS overlay"
          hint={settings.customCssPath || 'A local stylesheet applied over the skin.'}
          help="Overrides --vy-* tokens after the skin applies. Remote @import URLs are stripped. Max 256 KB."
        >
          <div className="flex items-center gap-2">
            <Button variant="subtle" disabled={locked} onClick={() => void pickCustomCss()}>
              {settings.customCssPath ? 'Change…' : 'Choose…'}
            </Button>
            {settings.customCssPath ? (
              <Button variant="ghost" disabled={locked} onClick={() => apply({ customCssPath: '' })}>
                Clear
              </Button>
            ) : null}
          </div>
          {customCssError ? (
            <p className="m-0 text-xs text-danger" role="alert">
              {customCssError}
            </p>
          ) : null}
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
