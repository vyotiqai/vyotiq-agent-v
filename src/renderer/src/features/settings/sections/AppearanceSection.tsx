import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  resolveFontScaleValue,
  type AppearanceSettings
} from '@shared/appearance'
import { Button, Segmented } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  ANNOUNCE_VERBOSITY_OPTIONS,
  CONTRAST_OPTIONS,
  FONT_SCALE_OPTIONS,
  REDUCE_MOTION_OPTIONS,
  THEME_OPTIONS
} from '../constants'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SwitchField } from '../components/SwitchField'
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

/** Snap a slider value to the numeric scale step and clamp it to the range. */
function snapFontScale(value: number): number {
  const snapped = Math.round(value / FONT_SCALE_STEP) * FONT_SCALE_STEP
  const rounded = Math.round(snapped * 100) / 100
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, rounded))
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

  const scaleValue = resolveFontScaleValue(settings.fontScale)
  const scalePercent = Math.round(scaleValue * 100)

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

      <SettingsGroup title="Text">
        <SettingsField
          id="appearance-font-scale"
          title="Text size"
          hint={textSizeHint()}
          below={
            <label className="mt-2 flex items-center gap-2 text-xs text-muted">
              <span className="sr-only">Text size scale</span>
              <input
                type="range"
                aria-label="Text size scale"
                min={FONT_SCALE_MIN}
                max={FONT_SCALE_MAX}
                step={FONT_SCALE_STEP}
                value={scaleValue}
                disabled={locked}
                onChange={(e) => apply({ fontScale: snapFontScale(Number(e.target.value)) })}
                className="w-40 accent-[var(--vy-accent)]"
              />
              <span className="tnum min-w-10 text-right" aria-live="off">
                {scalePercent}%
              </span>
            </label>
          }
          {...form.appearanceMark('fontScale')}
        >
          <Segmented
            label="Text size"
            value={typeof settings.fontScale === 'string' ? settings.fontScale : ''}
            disabled={locked}
            items={FONT_SCALE_OPTIONS.map((option) => ({
              id: String(option.value),
              label: option.label
            }))}
            onChange={(next) => {
              if (next !== settings.fontScale) apply({ fontScale: next as AppearanceSettings['fontScale'] })
            }}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Accessibility">
        <SelectField
          id="appearance-reduce-motion"
          title="Reduce motion"
          label="Reduce motion"
          hint="System follows your OS setting."
          value={settings.reduceMotion ?? 'system'}
          options={REDUCE_MOTION_OPTIONS}
          width={140}
          disabled={form.formLocked}
          {...form.defaultMark('reduceMotion')}
          onChange={(reduceMotion) => {
            void form.runUpdate({ reduceMotion })
          }}
        />
        <SelectField
          id="appearance-contrast"
          title="Contrast"
          label="Contrast"
          hint="More strengthens borders and text."
          value={settings.contrast ?? 'system'}
          options={CONTRAST_OPTIONS}
          width={140}
          disabled={form.formLocked}
          {...form.defaultMark('contrast')}
          onChange={(contrast) => {
            void form.runUpdate({ contrast })
          }}
        />
        <SwitchField
          id="appearance-focus-ring"
          title="Always show focus ring"
          hint="Show the focus outline on mouse focus too, not just keyboard focus."
          checked={settings.alwaysShowFocusRing ?? false}
          disabled={form.formLocked}
          {...form.defaultMark('alwaysShowFocusRing')}
          onChange={(alwaysShowFocusRing) => {
            void form.runUpdate({ alwaysShowFocusRing })
          }}
        />
        <SelectField
          id="appearance-announce"
          title="Screen reader announcements"
          label="Screen reader announcements"
          hint="How much the app announces: nothing, brief status only, or everything."
          value={settings.announceVerbosity ?? 'full'}
          options={ANNOUNCE_VERBOSITY_OPTIONS}
          width={140}
          disabled={form.formLocked}
          {...form.defaultMark('announceVerbosity')}
          onChange={(announceVerbosity) => {
            void form.runUpdate({ announceVerbosity })
          }}
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
