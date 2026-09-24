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
import { ActionMenu, Button, IconButton, type ActionMenuItem } from '@renderer/lib/ui'
import { DICTATION_ENGINE_OPTIONS, DICTATION_WAVEFORM_STYLE_OPTIONS } from '../constants'
import { ProgressBar } from '../components/ProgressBar'
import { SegmentedField } from '../components/SegmentedField'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

const WHISPER_MODELS = DICTATION_LOCAL_CATALOG.filter((m) => m.backend === 'whisper')

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${Math.round(n / (1024 * 1024))} MB`
}

function engineHint(engine: DictationEngine, secrets: Record<SecretProvider, boolean>): string {
  switch (engine) {
    case 'openai':
      return secrets.openai
        ? 'Transcribes with your OpenAI key.'
        : 'No OpenAI key yet — add one in Providers.'
    case 'openrouter':
      return secrets.openrouter
        ? 'Transcribes with your OpenRouter key.'
        : 'No OpenRouter key yet — add one in Providers.'
    case 'local':
      return 'Runs on this PC; nothing leaves it. English only.'
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}

/** The row's line under its name: what it weighs, and what this PC should pick. */
function modelHint(
  model: (typeof WHISPER_MODELS)[number],
  status: DictationRuntimeStatus | null
): string {
  const phase = status?.activeModelId === model.id ? status.phase : null
  if (phase === 'downloading') {
    return `Downloading${status?.progress != null ? ` · ${Math.round(status.progress * 100)}%` : ''}`
  }
  if (phase === 'loading') return status?.message ?? 'Loading'
  const installed = status?.installed.find((m) => m.id === model.id)
  const size =
    installed && installed.bytesOnDisk > 0
      ? `${formatBytes(installed.bytesOnDisk)} on disk`
      : installed
        ? 'On disk'
        : `${model.approxDownloadLabel} download`
  // The catalog's own "recommended" role is left out: this line names the one
  // recommended for this machine, and on a low-RAM PC that is the other one.
  return status?.recommendedModelId === model.id ? `${size} · recommended for this PC` : size
}

function ModelMenu({
  label,
  items,
  disabled
}: {
  label: string
  items: ActionMenuItem[]
  disabled: boolean
}) {
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const statusSeq = useRef(0)

  const refreshStatus = useCallback(() => {
    const seq = ++statusSeq.current
    void window.vyotiq.dictationStatus().then((res) => {
      if (seq !== statusSeq.current) return
      if (res.ok) {
        setRuntime(res.data)
        setLoadError(null)
      } else {
        setLoadError(res.error ?? 'Failed to load voice status')
      }
    })
  }, [])

  useEffect(() => {
    refreshStatus()
    const unsub =
      typeof window.vyotiq.onDictationStatus === 'function'
        ? window.vyotiq.onDictationStatus((status) => {
            statusSeq.current++
            setRuntime(status)
            setLoadError(null)
          })
        : undefined
    // Poll only while visible; a hidden settings window must not keep IPC awake.
    const poll = (): void => {
      if (document.visibilityState === 'hidden') return
      refreshStatus()
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') refreshStatus()
    }
    const id = unsub == null ? window.setInterval(poll, 1000) : window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsub?.()
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshStatus, dictation.engine, dictation.localModelId])

  const localInstalled = (runtime?.installed.length ?? 0) > 0
  const modelBusy = runtime?.phase === 'downloading' || runtime?.phase === 'loading'
  const locked = form.formLocked || busy || modelBusy
  const engineOptions = DICTATION_ENGINE_OPTIONS.map((opt) =>
    opt.value === 'local' ? { ...opt, disabled: !localInstalled } : opt
  )

  const patchEngine = (engine: DictationEngine): void => {
    if (engine === 'local' && !localInstalled) return
    let localModelId: DictationLocalModelId | '' =
      dictation.localModelId || runtime?.loadedModelId || runtime?.installed[0]?.id || ''
    if (engine === 'local' && !WHISPER_MODELS.some((m) => m.id === localModelId)) {
      localModelId =
        runtime?.loadedModelId || runtime?.installed[0]?.id || WHISPER_MODELS[0]?.id || ''
    }
    void form.runUpdate({ dictation: { ...dictation, engine, localModelId } })
  }

  const selectModel = (localModelId: DictationLocalModelId): void => {
    if (dictation.localModelId === localModelId) return
    void form.runUpdate({ dictation: { ...dictation, localModelId } })
  }

  const runModelAction = (
    action: () => Promise<{ ok: true; data: DictationRuntimeStatus } | { ok: false; error?: string }>
  ): void => {
    setBusy(true)
    setActionError(null)
    void action()
      .then((res) => {
        if (!res.ok) {
          setActionError(res.error ?? 'Voice action failed')
          return
        }
        statusSeq.current++
        setRuntime(res.data)
        setLoadError(null)
      })
      .finally(() => setBusy(false))
  }

  const error = actionError ?? loadError

  return (
    <SettingsStack>
      <SettingsGroup title="Dictation">
        <SegmentedField
          id="dictation-engine"
          title="Engine"
          label="Dictation engine"
          hint={engineHint(dictation.engine, secrets)}
          help="OpenAI and OpenRouter use gpt-transcribe; Local runs Whisper (ONNX) on this machine and is available once a model below is installed. Read on each mic stop — no restart."
          value={dictation.engine}
          options={engineOptions}
          disabled={locked}
          {...form.nestedDefaultMark('dictation', 'engine')}
          below={
            dictation.engine === 'local' && runtime && !localInstalled ? (
              <p className="m-0 text-xs text-danger" role="alert">
                Local is selected but no Whisper model is installed. Install one below, or switch engine.
              </p>
            ) : error ? (
              <p className="m-0 text-xs text-danger" role="alert">
                {error}
              </p>
            ) : null
          }
          onChange={patchEngine}
        />
        {WHISPER_MODELS.map((model) => {
          const inst = runtime?.installed.find((m) => m.id === model.id)
          const installed = inst != null
          const loaded = inst?.loaded === true
          const inUse = installed && dictation.localModelId === model.id
          const phaseForModel = runtime?.activeModelId === model.id ? runtime.phase : null
          const failed = phaseForModel === 'error'
          const working = phaseForModel === 'downloading' || phaseForModel === 'loading'
          const fieldId =
            model.id === 'whisper-tiny.en' ? 'dictation-whisper-tiny' : 'dictation-whisper-small'
          const menuItems: ActionMenuItem[] = [
            ...(loaded
              ? [
                  {
                    id: 'unload',
                    label: 'Unload from memory',
                    onSelect: () => runModelAction(() => window.vyotiq.dictationUnload())
                  }
                ]
              : []),
            {
              id: 'delete',
              label: 'Delete download',
              danger: true,
              separatorBefore: loaded,
              onSelect: () =>
                runModelAction(() => window.vyotiq.dictationDeleteCache({ modelId: model.id }))
            }
          ]
          return (
            <SettingsField
              key={model.id}
              id={fieldId}
              title={model.label}
              hint={modelHint(model, runtime)}
              help={`${model.language} only. ${model.ramHint}. Quantized q8 ONNX, cached in app data.`}
              below={
                working ? (
                  <ProgressBar
                    percent={runtime?.progress != null ? runtime.progress * 100 : null}
                    label={`${model.id} ${phaseForModel === 'loading' ? 'load' : 'download'} progress`}
                  />
                ) : failed ? (
                  <p className="m-0 text-xs text-danger" role="alert">
                    {runtime?.error ?? 'The model failed to load.'}
                  </p>
                ) : null
              }
            >
              <div className="flex items-center gap-3">
                {inUse ? <span className="text-caption font-medium text-accent">In use</span> : null}
                {failed ? (
                  <span className="text-xs text-danger">Error</span>
                ) : working || !installed ? null : loaded ? (
                  <span className="text-xs text-success">Ready · loaded</span>
                ) : (
                  <span className="text-xs text-muted">Ready · on disk</span>
                )}
                {!installed ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Install ${model.label}`}
                    pending={phaseForModel === 'downloading'}
                    disabled={locked}
                    onClick={() =>
                      runModelAction(() => window.vyotiq.dictationInstall({ modelId: model.id }))
                    }
                  >
                    Install
                  </Button>
                ) : null}
                {installed && !inUse ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Use ${model.label}`}
                    disabled={locked}
                    onClick={() => selectModel(model.id)}
                  >
                    Use
                  </Button>
                ) : null}
                {installed ? <ModelMenu label={model.label} items={menuItems} disabled={locked} /> : null}
              </div>
            </SettingsField>
          )
        })}
      </SettingsGroup>

      <SettingsGroup title="Composer">
        <SelectField
          id="dictation-waveform"
          title="Waveform"
          hint="The listening visualizer in the composer."
          value={dictation.waveformStyle ?? 'bars'}
          options={DICTATION_WAVEFORM_STYLE_OPTIONS}
          width={140}
          disabled={form.formLocked}
          {...form.nestedDefaultMark('dictation', 'waveformStyle')}
          onChange={(waveformStyle) => {
            void form.runUpdate({ dictation: { ...dictation, waveformStyle } })
          }}
        />
      </SettingsGroup>
    </SettingsStack>
  )
}
