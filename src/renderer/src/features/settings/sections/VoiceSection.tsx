import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type {
  DictationEngine,
  DictationLocalModelId,
  DictationRuntimeStatus,
  SecretProvider
} from '@shared/ipc'
import { DEFAULT_DICTATION_SETTINGS } from '@shared/ipc'
import { DICTATION_LOCAL_CATALOG } from '@shared/dictation'
import { Icon, type IconName } from '@renderer/lib/icons'
import { ActionMenu, Badge, Button, IconButton, Keys, Segmented, cn, type ActionMenuItem } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { listMicDevices, openMicCapture, MicCaptureError, type MicCapture } from '@renderer/lib/audio/micCapture'
import { levelFromRms, rmsOfInt16 } from '@renderer/lib/audio/segmenter'
import { LevelMeter } from '@renderer/features/chat/components/composer/take/TakeStrip'
import { METER_BARS } from '@renderer/features/chat/components/composer/take/takeController'
import { DICTATION_ENGINE_OPTIONS, DICTATION_ENTER_OPTIONS, DICTATION_LANGUAGE_OPTIONS } from '../constants'
import { ProgressBar } from '../components/ProgressBar'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'
import { SwitchField } from '../components/SwitchField'

/*
  Settings → Voice. Where the audio goes (never disabled — choosing This PC
  with no model shows the install right under it), the model only when it
  applies, the microphone with a live level, and how a take starts and ends.
*/

const LOCAL_MODELS = DICTATION_LOCAL_CATALOG

const ENGINE_ICON: Record<DictationEngine, IconName> = { local: 'lock', openai: 'cloud', openrouter: 'cloud' }
const ENGINE_PRIVACY: Record<DictationEngine, string> = {
  local: 'Audio stays on this PC',
  openai: 'Audio is sent to OpenAI with your key',
  openrouter: 'Audio is sent to OpenRouter with your key'
}
const ENGINE_NAME: Record<Exclude<DictationEngine, 'local'>, string> = { openai: 'OpenAI', openrouter: 'OpenRouter' }

/** How long a microphone test runs before it stops itself. */
const TEST_MS = 15000

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${Math.round(n / (1024 * 1024))} MB`
}

function formatSeconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-4 shrink-0 place-items-center rounded-full border', on ? 'border-accent' : 'border-border-strong')}
    >
      {on ? <span className="size-2 rounded-full bg-accent" /> : null}
    </span>
  )
}

function ModelMenu({ label, items, disabled }: { label: string; items: ActionMenuItem[]; disabled: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <ActionMenu
      open={open}
      onOpenChange={setOpen}
      placement="down"
      align="end"
      aria-label={`${label} actions`}
      items={items}
      trigger={(t) => (
        <IconButton
          ref={t.ref}
          icon="more"
          label={`More for ${label}`}
          size="sm"
          tone="muted"
          disabled={disabled}
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
        />
      )}
    />
  )
}

/** One model for this PC: pick it; see what it costs on disk and whether it is loaded. */
function ModelRow({
  model,
  runtime,
  selected,
  locked,
  onSelect,
  onInstall,
  onUnload,
  onDelete
}: {
  model: (typeof LOCAL_MODELS)[number]
  runtime: DictationRuntimeStatus | null
  selected: boolean
  locked: boolean
  onSelect: () => void
  onInstall: () => void
  onUnload: () => void
  onDelete: () => void
}) {
  const inst = runtime?.installed.find((m) => m.id === model.id)
  const phase = runtime?.activeModelId === model.id ? runtime.phase : null
  const working = phase === 'downloading' || phase === 'loading'
  const failed = phase === 'error'
  const recommended = runtime?.recommendedModelId === model.id
  const menu: ActionMenuItem[] = [
    ...(inst?.loaded ? [{ id: 'unload', label: 'Unload from memory', onSelect: onUnload }] : []),
    { id: 'delete', label: 'Delete download', danger: true, separatorBefore: Boolean(inst?.loaded), onSelect: onDelete }
  ]
  const percent = runtime?.progress != null ? runtime.progress * 100 : null
  const meta = working ? (
    <span className="flex items-center gap-2">
      <span className="w-40">
        <ProgressBar percent={percent} label={`${model.label} ${phase === 'loading' ? 'load' : 'download'} progress`} />
      </span>
      <span className={percent != null ? 'font-mono tnum' : undefined}>
        {percent != null ? `${Math.round(percent)}%` : phase === 'loading' ? 'Loading into memory' : 'Starting the download'}
      </span>
    </span>
  ) : failed ? (
    <span className="text-danger" role="alert">
      {runtime?.error ?? 'The model failed to load.'}
    </span>
  ) : inst ? (
    <>
      <span className="font-mono tnum">{inst.bytesOnDisk > 0 ? formatBytes(inst.bytesOnDisk) : 'On disk'}</span>
      {inst.bytesOnDisk > 0 ? ' on disk' : ''}
      {inst.loaded ? ' · loaded' : ''}
      {inst.callMs != null ? (
        <span title="How long one phrase took on this PC, lately">
          {' · '}
          <span className="font-mono tnum">{formatSeconds(inst.callMs)}</span> a phrase
        </span>
      ) : null}
    </>
  ) : (
    <>
      <span className="font-mono tnum">{model.approxDownloadLabel.replace('~', '')}</span> · {model.ramHint}
    </>
  )
  return (
    <div
      className={cn('flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5', selected ? 'bg-surface-2' : 'hover:bg-surface')}
      data-dictation-model={model.id}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={!inst || locked}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left focus-visible:vy-focus-ring disabled:cursor-default"
      >
        <Radio on={selected} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm text-fg-strong">
            {model.label}
            {recommended ? <Badge tone="outline">Best for this PC</Badge> : null}
          </span>
          <span className="mt-0.5 block text-xs text-muted">{meta}</span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1">
        {!inst && !working ? (
          <Button size="xs" variant="secondary" icon="download" aria-label={`Install ${model.label}`} disabled={locked} onClick={onInstall}>
            Install
          </Button>
        ) : null}
        {inst ? <ModelMenu label={model.label} items={menu} disabled={locked} /> : null}
      </span>
    </div>
  )
}

/** A few seconds of the chosen microphone's level, so you can see it hears you. */
function MicTest({ deviceId, onDevicesMayHaveLabels }: { deviceId: string; onDevicesMayHaveLabels: () => void }) {
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: METER_BARS }, () => 0))
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const captureRef = useRef<MicCapture | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    captureRef.current?.stop()
    captureRef.current = null
    setRunning(false)
  }, [])

  useEffect(() => stop, [stop])
  // A different device: stop measuring the old one.
  useEffect(() => stop, [deviceId, stop])

  const start = async (): Promise<void> => {
    setError(null)
    try {
      captureRef.current = await openMicCapture({
        deviceId: deviceId || undefined,
        onSamples: (pcm) => {
          const level = levelFromRms(rmsOfInt16(pcm))
          setLevels((prev) => [...prev.slice(1), level])
        },
        onEnded: stop
      })
      setRunning(true)
      onDevicesMayHaveLabels()
      timerRef.current = setTimeout(stop, TEST_MS)
    } catch (err) {
      setError(err instanceof MicCaptureError ? err.message : 'The microphone could not start')
    }
  }

  return (
    <div className="flex items-center gap-3">
      <LevelMeter levels={levels} live={running} />
      <span className="min-w-0 flex-1 text-xs text-tertiary">
        {error ? <span className="text-danger">{error}</span> : running ? 'Speak — the bars should move' : null}
      </span>
      <Button size="xs" variant={running ? 'ghost' : 'secondary'} onClick={() => (running ? stop() : void start())}>
        {running ? 'Stop' : 'Test'}
      </Button>
    </div>
  )
}

export function VoiceSection({
  form,
  secrets
}: {
  form: SettingsFormState
  secrets: Record<SecretProvider, boolean>
}) {
  const dictation = form.settings.dictation ?? DEFAULT_DICTATION_SETTINGS
  const [runtime, setRuntime] = useState<DictationRuntimeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Reading the model status failed; the next status that arrives answers it. */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  const statusSeq = useRef(0)

  const refreshStatus = useCallback(() => {
    const seq = ++statusSeq.current
    void window.vyotiq.dictationStatus().then((res) => {
      if (seq !== statusSeq.current) return
      if (res.ok) {
        setRuntime(res.data)
        setLoadError(null)
      } else setLoadError(res.error ?? 'Could not read the models on this PC')
    })
  }, [])

  const refreshDevices = useCallback(() => {
    void listMicDevices().then(setDevices)
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshDevices()
    const off = window.vyotiq.onDictationStatus?.((status) => {
      statusSeq.current++
      setRuntime(status)
      setLoadError(null)
    })
    const onDeviceChange = (): void => refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    return () => {
      off?.()
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
    }
  }, [refreshStatus, refreshDevices])

  const local = dictation.engine === 'local'
  const installedCount = runtime?.installed.length ?? 0
  const modelBusy = runtime?.phase === 'downloading' || runtime?.phase === 'loading'
  const locked = form.formLocked || busy
  const cloudMissingKey = !local && !secrets[dictation.engine as SecretProvider]
  const error = actionError ?? loadError

  const patch = (next: Partial<typeof dictation>): void => {
    void form.runUpdate({ dictation: { ...dictation, ...next } })
  }

  const setEngine = (engine: DictationEngine): void => {
    if (engine === 'local' && !dictation.localModelId) {
      const pick = runtime?.installed[0]?.id ?? runtime?.recommendedModelId ?? ''
      patch({ engine, localModelId: pick })
      return
    }
    patch({ engine })
  }

  const runModelAction = (
    action: () => Promise<{ ok: true; data: DictationRuntimeStatus } | { ok: false; error?: string }>
  ): void => {
    setBusy(true)
    setActionError(null)
    void action()
      .then((res) => {
        if (!res.ok) {
          setActionError(res.error ?? 'That did not work')
          return
        }
        statusSeq.current++
        setRuntime(res.data)
      })
      .finally(() => setBusy(false))
  }

  const install = (modelId: DictationLocalModelId): void => {
    if (!dictation.localModelId || installedCount === 0) patch({ localModelId: modelId })
    runModelAction(() => window.vyotiq.dictationInstall({ modelId }))
  }

  const selectedModel =
    dictation.localModelId || runtime?.loadedModelId || runtime?.installed[0]?.id || ''
  const deviceOptions = [
    { value: '', label: 'System default' },
    ...devices.filter((d) => d.deviceId).map((d) => ({ value: d.deviceId, label: d.label }))
  ]
  const deviceKnown = deviceOptions.some((o) => o.value === dictation.deviceId)

  return (
    <SettingsStack>
      <SettingsGroup title="Dictation" description="Speak a brief or an instruction; the words land at the cursor.">
        <SettingsField
          id="dictation-engine"
          title="Runs on"
          hint={
            <span className="inline-flex items-center gap-1.5">
              <Icon name={ENGINE_ICON[dictation.engine]} size={13} className="text-tertiary" />
              {ENGINE_PRIVACY[dictation.engine]}
              {local && runtime && installedCount === 0 ? ' · install a model below' : ''}
            </span>
          }
          {...form.nestedDefaultMark('dictation', 'engine')}
          below={
            cloudMissingKey ? (
              <div className="flex items-center gap-2 text-xs text-danger" role="alert">
                <Icon name="warningCircle" size={13} />
                <span className="flex-1">{`No ${ENGINE_NAME[dictation.engine as Exclude<DictationEngine, 'local'>]} key yet — the mic cannot start.`}</span>
                <Button size="xs" variant="secondary" icon="key" onClick={() => form.navigateSection('providers')}>
                  Add key
                </Button>
              </div>
            ) : null
          }
        >
          <Segmented
            label="Runs on"
            value={dictation.engine}
            disabled={locked}
            items={DICTATION_ENGINE_OPTIONS.map((o) => ({
              id: o.value,
              label: o.label,
              icon: o.value === 'local' ? ('lock' as const) : undefined
            }))}
            onChange={(next) => {
              if (next !== dictation.engine) setEngine(next)
            }}
          />
        </SettingsField>
        {dictation.engine === 'openai' ? (
          <SwitchField
            id="dictation-live-words"
            title="Words as you speak"
            hint="A live OpenAI session writes each word as you say it, instead of each phrase after you pause. About 4× the price a minute ($0.017 against $0.0045)."
            checked={dictation.liveWords}
            disabled={locked}
            {...form.nestedDefaultMark('dictation', 'liveWords')}
            onChange={(liveWords) => patch({ liveWords })}
          />
        ) : null}
        <SettingsField
            id="dictation-model"
            title="Model"
            hint={
              local
                ? 'All run offline once downloaded. Switching is instant. With Whisper Tiny installed, it writes live words for the others.'
                : 'For when dictation runs on this PC — no key, and nothing leaves it.'
            }
            // A wide row's control is its body; `below` would be dropped, so the
            // error sits under the models inside it.
            wide
          >
            <div className="-mx-2 space-y-px" role="radiogroup" aria-label="Model">
              {LOCAL_MODELS.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  runtime={runtime}
                  selected={selectedModel === model.id && runtime?.installed.some((m) => m.id === model.id) === true}
                  locked={locked || modelBusy}
                  onSelect={() => patch({ localModelId: model.id })}
                  onInstall={() => install(model.id)}
                  onUnload={() => runModelAction(() => window.vyotiq.dictationUnload())}
                  onDelete={() => runModelAction(() => window.vyotiq.dictationDeleteCache({ modelId: model.id }))}
                />
              ))}
            </div>
            {error ? (
              <p className="m-0 mt-2 text-xs text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </SettingsField>
        <SelectField
          id="dictation-language"
          title="Language"
          hint={local ? 'Dictation on this PC understands English only.' : 'A hint for the transcription; detection works for most speech.'}
          value={local ? 'en' : dictation.language}
          options={local ? [{ value: 'en', label: 'English' }] : DICTATION_LANGUAGE_OPTIONS}
          width={200}
          disabled={locked || local}
          {...(local ? {} : form.nestedDefaultMark('dictation', 'language'))}
          onChange={(language) => patch({ language })}
        />
        <SelectField
          id="dictation-input"
          title="Microphone"
          hint="Follows the system default unless you pick one."
          value={deviceKnown ? dictation.deviceId : ''}
          options={deviceOptions}
          width={260}
          disabled={locked}
          {...form.nestedDefaultMark('dictation', 'deviceId')}
          onChange={(deviceId) => patch({ deviceId })}
          below={<MicTest deviceId={dictation.deviceId} onDevicesMayHaveLabels={refreshDevices} />}
        />
      </SettingsGroup>

      <SettingsGroup title="Controls">
        <SettingsField
          id="dictation-shortcut"
          title="Shortcut"
          hint="Starts a take anywhere a brief or an instruction can be typed. Tap again to insert."
        >
          <Keys keys={shortcutLabel('dictation').split('+')} />
        </SettingsField>
        <SwitchField
          id="dictation-hold"
          title="Hold to talk"
          hint="Hold the shortcut while you speak; letting go inserts. A tap still starts and stops a take."
          checked={dictation.holdToTalk}
          disabled={locked}
          {...form.nestedDefaultMark('dictation', 'holdToTalk')}
          onChange={(holdToTalk) => patch({ holdToTalk })}
        />
        <SegmentedField
          id="dictation-enter"
          title="Enter ends a take by"
          hint={`${window.vyotiq?.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter does the other one.`}
          value={dictation.enterAction}
          options={DICTATION_ENTER_OPTIONS}
          disabled={locked}
          {...form.nestedDefaultMark('dictation', 'enterAction')}
          onChange={(enterAction) => patch({ enterAction })}
        />
      </SettingsGroup>
    </SettingsStack>
  )
}
