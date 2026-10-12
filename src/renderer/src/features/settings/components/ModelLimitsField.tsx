import { useCallback, useEffect, useState, type JSX } from 'react'
import type { ModelInfo, ProviderIdAny } from '@shared/ipc'
import { modelLimitKey, type ModelLimitOverride } from '@shared/domain/modelLimits'
import { Button, Input, cn } from '@renderer/lib/ui'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import type { SettingsFormState } from '../hooks/useSettingsForm'

/** Rows shown before "Show all". */
const ROWS_SHOWN = 6

/** Where a model's window comes from, in words, muted unless set by hand. */
function sourceWords(model: ModelInfo, hasOverride: boolean): string {
  if (hasOverride || model.limitsSource === 'user') return 'set by you'
  if (model.limitsSource === 'server') return 'from the server'
  return model.contextWindow ? 'reported' : 'guessed'
}

function parseTokens(text: string): number | undefined {
  const cleaned = text.trim().toLowerCase().replace(/[,_\s]/g, '')
  if (!cleaned) return undefined
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(cleaned)
  if (!m) return NaN
  const n = Number(m[1]) * (m[2] === 'k' ? 1024 : m[2] === 'm' ? 1024 * 1024 : 1)
  return Math.round(n)
}

/**
 * The context window and output limit the app plans prompts for, per model,
 * for a local server or custom endpoint — editable where the server does not
 * report them. An 8k model was otherwise sent prompts sized for a 128k guess.
 */
export function ModelLimitsField({
  providerId,
  baseUrl,
  form
}: {
  providerId: ProviderIdAny
  baseUrl?: string
  form: SettingsFormState
}): JSX.Element | null {
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [all, setAll] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [windowDraft, setWindowDraft] = useState('')
  const [outputDraft, setOutputDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const overrides = form.settings.modelLimits ?? {}

  const load = useCallback(async () => {
    const res = await window.vyotiq?.listModels?.({ provider: providerId, ...(baseUrl ? { baseUrl } : {}) })
    setModels(res?.ok ? res.data.models.filter((m) => !m.isPlaceholder) : [])
  }, [providerId, baseUrl])
  useEffect(() => {
    void load()
  }, [load])

  if (!models || models.length === 0) return null
  const shown = all ? models : models.slice(0, ROWS_SHOWN)

  const save = async (modelId: string, next: ModelLimitOverride | null): Promise<void> => {
    const key = modelLimitKey(providerId, modelId)
    const rest = { ...overrides }
    delete rest[key]
    const ok = await form.runUpdate({ modelLimits: next ? { ...rest, [key]: next } : rest })
    if (ok) {
      setEditing(null)
      void load()
    }
  }

  const commit = (modelId: string): void => {
    const contextWindow = parseTokens(windowDraft)
    const maxOutputTokens = parseTokens(outputDraft)
    if (Number.isNaN(contextWindow) || Number.isNaN(maxOutputTokens)) {
      setError('Use a number of tokens, like 32768 or 32k.')
      return
    }
    if (contextWindow !== undefined && contextWindow < 1024) {
      setError('A context window under 1k tokens cannot hold the agent’s instructions.')
      return
    }
    setError(null)
    void save(
      modelId,
      contextWindow || maxOutputTokens
        ? { ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) }
        : null
    )
  }

  return (
    <div className="flex flex-col gap-1" data-model-limits={providerId}>
      <p className="m-0 text-xs text-muted">
        Model limits — what prompts are sized for. Set them when the server does not report its own.
      </p>
      <ul className="m-0 list-none p-0">
        {shown.map((model) => {
          const key = modelLimitKey(providerId, model.id)
          const override = overrides[key]
          const isEditing = editing === model.id
          return (
            <li key={model.id} className="py-0.5" data-model-limit={model.id}>
              <div className="flex h-7 items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-mono text-fg" title={model.id}>
                  {model.id}
                </span>
                <span className={cn('shrink-0 tabular-nums', override ? 'text-fg' : 'text-tertiary')}>
                  {model.contextWindow ? `${formatTokens(model.contextWindow)} context` : 'unknown'}
                  {model.maxOutputTokens && (override?.maxOutputTokens || model.limitsSource === 'user')
                    ? ` · ${formatTokens(model.maxOutputTokens)} out`
                    : ''}
                  {' · '}
                  {sourceWords(model, Boolean(override))}
                </span>
                {isEditing ? null : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={form.formLocked}
                    aria-label={`Set limits for ${model.id}`}
                    onClick={() => {
                      setEditing(model.id)
                      setError(null)
                      setWindowDraft(override?.contextWindow ? String(override.contextWindow) : '')
                      setOutputDraft(override?.maxOutputTokens ? String(override.maxOutputTokens) : '')
                    }}
                  >
                    Set
                  </Button>
                )}
              </div>
              {isEditing ? (
                <div className="flex flex-wrap items-center gap-2 pb-1">
                  <span className="w-36">
                    <Input
                      size="sm"
                      mono
                      aria-label={`Context window for ${model.id}`}
                      placeholder="Context, e.g. 32k"
                      value={windowDraft}
                      onChange={(e) => setWindowDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit(model.id)
                      }}
                    />
                  </span>
                  <span className="w-36">
                    <Input
                      size="sm"
                      mono
                      aria-label={`Max output for ${model.id}`}
                      placeholder="Max output, optional"
                      value={outputDraft}
                      onChange={(e) => setOutputDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit(model.id)
                      }}
                    />
                  </span>
                  <Button size="xs" variant="primary" onClick={() => commit(model.id)}>
                    Save
                  </Button>
                  {override ? (
                    <Button size="xs" variant="ghost" onClick={() => void save(model.id, null)}>
                      Reset
                    </Button>
                  ) : null}
                  <Button size="xs" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  {error ? (
                    <p className="m-0 w-full text-xs text-danger" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {models.length > ROWS_SHOWN ? (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `Show all ${models.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
