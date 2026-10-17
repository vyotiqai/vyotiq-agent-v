import { useEffect, useState } from 'react'
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  USER_NAME_MAX,
  resolveFontScaleValue,
  type AppearanceSettings
} from '@shared/appearance'
import { Button, Input, Segmented } from '@renderer/lib/ui'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { SettingsViewProps } from '../types'
import {
  ANNOUNCE_VERBOSITY_OPTIONS,
  CONTRAST_OPTIONS,
  FONT_SCALE_OPTIONS,
  HOME_BACKDROP_OPTIONS,
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

      <HomeGroup form={form} />

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

/**
 * What Home looks like: the band behind its head and the name its greeting
 * uses. A picture is copied in by main when picked; Remove deletes the copy.
 */
function HomeGroup({ form }: { form: SettingsFormState }) {
  const settings = form.settings
  const [pickError, setPickError] = useState<string | null>(null)
  const [draft, setDraft] = useState(settings.userName)
  useEffect(() => setDraft(settings.userName), [settings.userName])
  const hasPicture = settings.homeBackdropImageStamp !== ''

  const pickPicture = async (): Promise<void> => {
    setPickError(null)
    const res = await window.vyotiq?.appearancePickHomeBackdrop?.()
    if (!res) return
    if (!res.ok) {
      setPickError(res.error)
      return
    }
    if (res.data) await form.runUpdate({ homeBackdrop: 'image', homeBackdropImageStamp: res.data.stamp })
  }

  const removePicture = async (): Promise<void> => {
    setPickError(null)
    await window.vyotiq?.appearanceClearHomeBackdrop?.()
    await form.runUpdate({
      homeBackdropImageStamp: '',
      ...(settings.homeBackdrop === 'image' ? { homeBackdrop: 'pixels' as const } : {})
    })
  }

  const commitName = (): void => {
    const next = draft.trim().slice(0, USER_NAME_MAX)
    setDraft(next)
    if (next !== settings.userName) void form.runUpdate({ userName: next })
  }

  return (
    <SettingsGroup title="Home">
      <SegmentedField
        id="appearance-home-backdrop"
        title="Backdrop"
        label="Home backdrop"
        hint="A band behind Home's day and sentence, in your skin's colours or from a picture."
        value={settings.homeBackdrop}
        options={HOME_BACKDROP_OPTIONS}
        disabled={form.formLocked}
        {...form.defaultMark('homeBackdrop')}
        onChange={(homeBackdrop) => {
          setPickError(null)
          // Picture with nothing picked yet goes straight to the picker.
          if (homeBackdrop === 'image' && !hasPicture) void pickPicture()
          else void form.runUpdate({ homeBackdrop })
        }}
      />
      {settings.homeBackdrop === 'image' || hasPicture ? (
        <SettingsField
          id="appearance-home-picture"
          title="Picture"
          hint="Toned toward your skin so text over it stays readable. PNG, JPEG, WebP, AVIF, GIF or BMP, up to 8 MB."
          below={
            pickError ? (
              <p className="m-0 text-xs text-danger" role="alert">
                {pickError}
              </p>
            ) : null
          }
        >
          <div className="flex items-center gap-1.5">
            {hasPicture ? (
              <Button size="sm" variant="ghost" disabled={form.formLocked} onClick={() => void removePicture()}>
                Remove
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" disabled={form.formLocked} onClick={() => void pickPicture()}>
              {hasPicture ? 'Change…' : 'Choose picture…'}
            </Button>
          </div>
        </SettingsField>
      ) : null}
      <SettingsField
        id="appearance-user-name"
        title="Your name"
        hint="Home greets you with it. Leave empty for no greeting."
        {...form.defaultMark('userName')}
      >
        <Input
          size="sm"
          aria-label="Your name"
          placeholder="Your name"
          maxLength={USER_NAME_MAX}
          autoComplete="off"
          spellCheck={false}
          disabled={form.formLocked}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="w-48"
        />
      </SettingsField>
    </SettingsGroup>
  )
}
