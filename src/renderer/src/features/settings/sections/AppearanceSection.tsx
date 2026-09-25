import type { AppearanceSettings } from '@shared/appearance'
import { Button } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import { DENSITY_OPTIONS, FONT_SCALE_OPTIONS, THEME_OPTIONS } from '../constants'
import { SegmentedField } from '../components/SegmentedField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SkinPicker } from '../components/SkinPicker'

const CUSTOM_CSS_RULES = 'Overrides --vy-* tokens. Remote @import is stripped; 256 KB max.'

/** The OS whose light or dark "System" follows. */
function systemName(): string {
  const platform = window.vyotiq?.platform
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  return 'your desktop'
}

/** The text-size chords App handles anywhere in the window (Ctrl = / − / 0). */
function textSizeHint(): string {
  const mod = window.vyotiq?.platform === 'darwin' ? '⌘' : 'Ctrl'
  return `${mod} + and ${mod} − work anywhere.`
}

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

  const apply = (partial: Partial<AppearanceSettings>): void => {
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
      <SettingsGroup title="Skin" fieldId="appearance-skin" plain>
        <SkinPicker
          value={settings.skinId}
          disabled={locked}
          mark={form.appearanceMark('skinId')}
          onChange={(skinId) => apply({ skinId })}
        />
      </SettingsGroup>

      <SettingsGroup title="Colour mode">
        <SegmentedField
          id="appearance-theme"
          title="Mode"
          label="Colour mode"
          hint={`System follows ${systemName()}.`}
          value={settings.theme}
          options={THEME_OPTIONS}
          disabled={locked}
          onChange={(theme) => apply({ theme })}
          {...form.appearanceMark('theme')}
        />
      </SettingsGroup>

      <SettingsGroup title="Text and spacing">
        <SegmentedField
          id="appearance-font-scale"
          title="Text size"
          hint={textSizeHint()}
          value={settings.fontScale}
          options={FONT_SCALE_OPTIONS}
          disabled={locked}
          onChange={(fontScale) => apply({ fontScale })}
          {...form.appearanceMark('fontScale')}
        />
        <SegmentedField
          id="appearance-density"
          title="Density"
          hint="Row and control height."
          value={settings.uiDensity}
          options={DENSITY_OPTIONS}
          disabled={locked}
          onChange={(uiDensity) => apply({ uiDensity })}
          {...form.appearanceMark('uiDensity')}
        />
      </SettingsGroup>

      <SettingsGroup title="Custom CSS">
        <SettingsField
          id="appearance-custom-css"
          title="User CSS overlay"
          // Once a file is chosen, which file is the question; the rules go
          // to the tooltip.
          hint={
            settings.customCssPath ? (
              <span className="font-mono" title={settings.customCssPath}>
                {settings.customCssPath}
              </span>
            ) : (
              CUSTOM_CSS_RULES
            )
          }
          help={settings.customCssPath ? CUSTOM_CSS_RULES : undefined}
          below={
            customCssError ? (
              <p className="m-0 text-xs text-danger" role="alert">
                {customCssError}
              </p>
            ) : null
          }
          {...form.appearanceMark('customCssPath')}
        >
          <div className="flex items-center gap-1.5">
            {settings.customCssPath ? (
              <Button size="sm" variant="ghost" disabled={locked} onClick={() => apply({ customCssPath: '' })}>
                Clear
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" disabled={locked} onClick={() => void pickCustomCss()}>
              {settings.customCssPath ? 'Change…' : 'Choose file…'}
            </Button>
          </div>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
