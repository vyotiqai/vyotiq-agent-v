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
import { AlertBlock, Button } from '@renderer/lib/ui'
import { DICTATION_ENGINE_OPTIONS, DICTATION_WAVEFORM_STYLE_OPTIONS } from '../constants'
import { ProgressBar } from '../components/ProgressBar'
import { SelectField } from '../components/SelectField'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

const WHISPER_MODELS = DICTATION_LOCAL_CATALOG.filter((m) => m.backend === 'whisper')

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
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
      return 'Whisper on this machine. Offline, English only.'
    default: {
      const _exhaustive: never = engine
      return _exhaustive
    }
  }
}

function modelStatusLabel(
  modelId: DictationLocalModelId,
  status: DictationRuntimeStatus | null
): string {
  if (!status) return 'Checking…'
  if (status.phase === 'downloading' && status.activeModelId === modelId) {
    const pct = status.progress != null ? ` ${Math.round(status.progress * 100)}%` : ''
    return `Downloading${pct}`
  }
  if (status.phase === 'loading' && status.activeModelId === modelId) {
    return status.message ?? 'Loading'
  }
  if (status.phase === 'error' && status.activeModelId === modelId) {
    return `Error${status.error ? `: ${status.error}` : ''}`
  }
  const inst = status.installed.find((m) => m.id === modelId)
  if (inst?.loaded) return 'Ready · loaded'
  if (inst) return 'Ready · on disk'
  return 'Not installed'
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

  return (
    <SettingsStack>
      <SettingsGroup title="Dictation">
        <SelectField
          id="dictation-engine"
          title="Dictation engine"
          hint={engineHint(dictation.engine, secrets)}
          help="OpenAI and OpenRouter use gpt-transcribe; Local runs Whisper (ONNX) on this machine and is available once a model below is installed. Read on each mic stop — no restart."
          value={dictation.engine}
          options={engineOptions}
          disabled={locked}
          onChange={patchEngine}
        />
        {dictation.engine === 'local' && runtime && !localInstalled ? (
          <p className="m-0 px-4 py-3 text-xs text-danger" role="alert">
            Local is selected but no Whisper model is installed. Install one below, or switch
            engine.
          </p>
        ) : null}
        <SelectField
          id="dictation-waveform"
          title="Waveform"
          hint="The listening visualizer in the composer."
          value={dictation.waveformStyle ?? 'bars'}
          options={DICTATION_WAVEFORM_STYLE_OPTIONS}
          disabled={form.formLocked}
          onChange={(waveformStyle) => {
            void form.runUpdate({ dictation: { ...dictation, waveformStyle } })
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Local Whisper models">
        {WHISPER_MODELS.map((model) => {
          const inst = runtime?.installed.find((m) => m.id === model.id)
          const installed = inst != null
          const loaded = inst?.loaded === true
          const inUse = installed && dictation.localModelId === model.id
          const recommended = runtime?.recommendedModelId === model.id
          const phaseForModel = runtime?.activeModelId === model.id ? runtime.phase : null
          const failed = phaseForModel === 'error'
          const fieldId =
            model.id === 'whisper-tiny.en' ? 'dictation-whisper-tiny' : 'dictation-whisper-small'
          return (
            <SettingsField
              key={model.id}
              id={fieldId}
              title={model.label}
              // Size and when to pick it. The catalog's static "Recommended"
              // role is left out: the status line names the model recommended
              // for this machine, and on a low-RAM PC that is the other one.
              hint={`${model.approxDownloadLabel} · ${model.ramHint}`}
              help={`${model.language} only. Quantized q8 ONNX, cached in app data. Unload frees memory; Delete removes the files.`}
              wide
            >
              <p
                className={failed ? 'm-0 text-xs text-danger' : 'm-0 text-xs text-secondary'}
                role={failed ? 'alert' : undefined}
              >
                {modelStatusLabel(model.id, runtime)}
                {installed && inst.bytesOnDisk > 0 ? ` · ${formatBytes(inst.bytesOnDisk)} on disk` : ''}
                {inUse ? ' · In use' : ''}
                {recommended ? ' · Recommended for this PC' : ''}
              </p>
              {phaseForModel === 'downloading' || phaseForModel === 'loading' ? (
                <ProgressBar
                  percent={runtime?.progress != null ? runtime.progress * 100 : null}
                  label={`${model.id} ${phaseForModel === 'loading' ? 'load' : 'download'} progress`}
                />
              ) : null}
              {/* Short visible labels; the accessible name keeps the model, since
                  both cards carry the same four verbs. */}
              <div className="flex flex-wrap gap-2">
                {!installed ? (
                  <Button
                    variant="subtle"
                    aria-label={`Install ${model.label}`}
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
                    variant="subtle"
                    aria-label={`Use ${model.label}`}
                    disabled={locked}
                    onClick={() => selectModel(model.id)}
                  >
                    Use
                  </Button>
                ) : null}
                {loaded ? (
                  <Button
                    variant="subtle"
                    aria-label={`Unload ${model.label}`}
                    disabled={locked}
                    onClick={() => runModelAction(() => window.vyotiq.dictationUnload())}
                  >
                    Unload
                  </Button>
                ) : null}
                {installed ? (
                  <Button
                    variant="danger"
                    aria-label={`Delete ${model.label} cache`}
                    disabled={locked}
                    onClick={() =>
                      runModelAction(() => window.vyotiq.dictationDeleteCache({ modelId: model.id }))
                    }
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </SettingsField>
          )
        })}
        {actionError || loadError ? (
          <div className="flex flex-col gap-1.5 px-4 py-3">
            {actionError ? <AlertBlock>{actionError}</AlertBlock> : null}
            {loadError ? <AlertBlock>{loadError}</AlertBlock> : null}
          </div>
        ) : null}
      </SettingsGroup>
    </SettingsStack>
  )
}
