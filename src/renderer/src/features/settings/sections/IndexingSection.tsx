import { useCallback, useEffect, useState } from 'react'
import type { SettingsFormState } from '../hooks/useSettingsForm'
import type { CodeIndexEmbedderSetting, CodeIndexRuntimeStatus, ProcessMetricsSnapshot } from '@shared/ipc'
import { Input, Switch, Button, Menu } from '@renderer/lib/ui'
import { CODEINDEX_EMBEDDER_OPTIONS } from '../constants'
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

function phaseLabel(status: CodeIndexRuntimeStatus | null): string {
  if (!status) return 'Unknown'
  switch (status.phase) {
    case 'ready':
      return `Ready · ${status.modelId || 'model'}`
    case 'downloading': {
      const pct =
        status.progress != null ? ` ${Math.round(status.progress * 100)}%` : ''
      return `Downloading${pct}${status.message ? ` · ${status.message}` : ''}`
    }
    case 'loading':
      return status.message ?? 'Loading model'
    case 'indexing': {
      const ip = status.indexProgress
      if (ip) {
        const kind = ip.kind === 'code' ? 'Code index' : 'Sparse grep'
        return `${kind} · ${ip.stage}`
      }
      const pct =
        status.progress != null ? ` · ${Math.round(status.progress * 100)}%` : ''
      return status.message ?? `Indexing${pct}`
    }
    case 'fallback_hash':
      return `Fallback hash${status.message ? ` · ${status.message}` : ''}`
    case 'error':
      return `Error${status.error ? `: ${status.error}` : ''}`
    case 'idle':
      return status.message ?? 'Idle'
    default: {
      const _exhaustive: never = status.phase
      return _exhaustive
    }
  }
}

function IndexProgressPanel({ status }: { status: CodeIndexRuntimeStatus | null }) {
  if (!status) return null
  const showBar =
    status.phase === 'downloading' ||
    status.phase === 'indexing' ||
    status.phase === 'loading'
  const pct =
    status.progress != null && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, Math.round(status.progress * 100)))
      : null
  const ip = status.indexProgress
  const showDetail = ip != null && status.phase === 'indexing'

  return (
    <div className="flex w-full flex-col gap-1.5">
      <p className="m-0 text-xs text-secondary">{phaseLabel(status)}</p>
      {showBar && pct != null ? (
        <div
          className="h-1.5 w-full overflow-hidden rounded-sm bg-border"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label="Index progress"
        >
          <div
            className="h-full bg-accent transition-[width] duration-100 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
      {showDetail ? (
        <div className="m-0 grid grid-cols-2 gap-x-3 gap-y-0.5 text-caption text-secondary">
          <span>
            {ip.filesDone}/{ip.filesTotal} scanned
          </span>
          <span className="text-right">
            {ip.embedChunks > 0 ? `${ip.embedChunks} chunks embedded` : '\u00a0'}
          </span>
          <span>
            {ip.indexed} updated · {ip.skipped} unchanged
            {ip.removed > 0 ? ` · ${ip.removed} removed` : ''}
          </span>
          <span className="text-right text-muted">
            {ip.indexed + ip.skipped > 0
              ? `${ip.indexed + ip.skipped} text files`
              : '\u00a0'}
          </span>
          {ip.currentPath ? (
            <span className="col-span-2 truncate font-mono text-2xs" title={ip.currentPath}>
              {ip.currentPath}
            </span>
          ) : null}
        </div>
      ) : status.phase === 'indexing' && status.message ? (
        <p className="m-0 text-caption text-secondary">{status.message}</p>
      ) : null}
    </div>
  )
}

function mbForType(snap: ProcessMetricsSnapshot, type: string): number {
  return snap.byType.find((row) => row.type === type)?.workingSetMb ?? 0
}

function processMetricsLabel(snap: ProcessMetricsSnapshot): string {
  const embed = snap.embedUtility.rssMb
  const embedPart = embed != null ? `${Math.round(embed)} MB` : 'unloaded'
  return `Main ${mbForType(snap, 'Browser')} MB · GPU ${mbForType(snap, 'GPU')} MB · Tabs ${mbForType(snap, 'Tab')} MB · Embed ${embedPart} · ${snap.totalWorkingSetMb} MB total`
}

export function IndexingSection({ form }: { form: SettingsFormState }) {
  const codeIndex = form.settings.codeIndex ?? {
    enabled: true,
    embedder: 'mdenseon' as const,
    autoDownload: true,
    ollamaModel: 'nomic-embed-text',
    lfm2OllamaModel: 'hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF'
  }
  const [runtime, setRuntime] = useState<CodeIndexRuntimeStatus | null>(null)
  const [reindexBusy, setReindexBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [processMetrics, setProcessMetrics] = useState<ProcessMetricsSnapshot | null>(null)

  const refreshStatus = useCallback(() => {
    void window.vyotiq.codeIndexStatus().then((res) => {
      if (res.ok) {
        const { settings: _s, ...rest } = res.data
        setRuntime(rest)
        setStatusError(null)
      } else {
        setStatusError(res.error ?? 'Failed to load index status')
      }
    })
  }, [])

  useEffect(() => {
    refreshStatus()
    const unsub =
      typeof window.vyotiq.onCodeIndexStatus === 'function'
        ? window.vyotiq.onCodeIndexStatus((status) => {
            setRuntime(status)
            setStatusError(null)
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
    // Fallback poll only when push subscription is unavailable.
    const id = unsub == null ? window.setInterval(poll, 1000) : window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      unsub?.()
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshStatus, codeIndex.embedder, codeIndex.enabled, codeIndex.autoDownload])

  useEffect(() => {
    let cancelled = false
    const pull = (): void => {
      if (typeof window.vyotiq.processMetrics !== 'function') return
      void window.vyotiq.processMetrics().then((res) => {
        if (cancelled || !res.ok) return
        setProcessMetrics(res.data)
      })
    }
    const poll = (): void => {
      if (document.visibilityState === 'hidden') return
      pull()
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') pull()
    }
    pull()
    const id = window.setInterval(poll, 8000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const patchCodeIndex = (partial: Partial<typeof codeIndex>) => {
    void form.runUpdate({
      codeIndex: { ...codeIndex, ...partial }
    })
  }

  return (
    <SettingsStack>
      <SettingsGroup title="Codebase indexing">
        <SettingsField
          id="codeindex-enabled"
          title="Enable codebase index"
          hint="Powers codebase_search (local hybrid retrieval)."
          help="Index lives under app userData (not the project tree). Code never leaves the machine for the local ONNX path."
        >
          <Switch
            size="md"
            checked={codeIndex.enabled}
            disabled={form.formLocked}
            label="Enable codebase index"
            onCheckedChange={(checked) => patchCodeIndex({ enabled: checked })}
          />
        </SettingsField>

        <SettingsField
          id="codeindex-embedder"
          title="Embedder"
          hint="LightOn dense ONNX (default — batched) · LFM2.5-Embedding-350M · Ollama · hash fallback. Reindex after changing."
          help="Default is LightOn dense ONNX, which batches chunks and runs in a utility process (~10× faster than llama.cpp). LFM2.5-Embedding-350M (1024-dim, 11 languages) is selectable: it resolves to your local exported ONNX first, then a bundled llama.cpp (node-llama-cpp) that pulls the GGUF straight from Hugging Face — no Ollama server and no manual export, fully local — then a local Ollama GGUF, then LightOn DenseOn so retrieval stays semantic. LFM2.5 ONNX export (scripts/export-lfm2-embedding-onnx.py) is optional and takes precedence. LightOn DenseOn auto-downloads its INT8 ONNX (~150MB); mDenseOn is used only if its ONNX is already on disk. Hash is offline bag-of-tokens. Closing open indexes happens automatically; click Reindex workspace to rebuild under the new embedder."
        >
          <Menu
            aria-label="Codebase embedder"
            value={codeIndex.embedder}
            options={CODEINDEX_EMBEDDER_OPTIONS}
            searchable={false}
            placement="down"
            disabled={form.formLocked || !codeIndex.enabled}
            onChange={(v) => patchCodeIndex({ embedder: v as CodeIndexEmbedderSetting })}
          />
        </SettingsField>

        <SettingsField
          id="codeindex-auto-download"
          title="Auto-download model"
          hint="Fetch DenseOn ONNX on first use (default embedder; also covers the LFM2 fallback)."
          help="When on, the DenseOn/LFM2 paths auto-fetch DenseOn INT8 bootstrap weights under userData/codeindex/models/ so retrieval stays semantic even without LFM2 weights. mDenseOn and LFM2.5-Embedding-350M are never auto-fetched (no public ONNX; you export LFM2's, or serve it via Ollama). When off, an unavailable neural model falls back to hash until weights are present."
        >
          <Switch
            size="md"
            checked={codeIndex.autoDownload}
            disabled={
              form.formLocked ||
              !codeIndex.enabled ||
              (codeIndex.embedder !== 'mdenseon' && codeIndex.embedder !== 'lfm2')
            }
            label="Auto-download embedder model"
            onCheckedChange={(checked) => patchCodeIndex({ autoDownload: checked })}
          />
        </SettingsField>

        {codeIndex.embedder === 'lfm2' ? (
          <SettingsField
            id="codeindex-lfm2-ollama-model"
            title="LFM2 Ollama GGUF model"
            hint="Optional Ollama fallback when the bundled llama.cpp path is unavailable."
            help="LFM2 normally loads via the bundled llama.cpp (node-llama-cpp), which downloads the GGUF from Hugging Face automatically — no Ollama needed. This field only matters if you prefer running LFM2 through a local Ollama server instead: set its model tag (e.g. `hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF`) and ensure Ollama is running with that model pulled. ONNX export (scripts/export-lfm2-embedding-onnx.py) still takes precedence over both."
          >
            <Input
              className="max-w-xs"
              aria-label="LFM2 Ollama GGUF model"
              disabled={form.formLocked}
              defaultValue={codeIndex.lfm2OllamaModel ?? 'hf.co/LiquidAI/LFM2.5-Embedding-350M-GGUF'}
              key={`ci-lfm2-${codeIndex.lfm2OllamaModel}`}
              onBlur={(e) => {
                const v = e.target.value.trim() || 'liquidai/lfm2.5-embedding-350m'
                if (v !== codeIndex.lfm2OllamaModel) patchCodeIndex({ lfm2OllamaModel: v })
              }}
            />
          </SettingsField>
        ) : null}

        {codeIndex.embedder === 'ollama' ? (
          <SettingsField
            id="codeindex-ollama-model"
            title="Ollama embedding model"
            hint="Model name passed to /api/embeddings."
            help="Uses the Ollama base URL from Settings → Providers."
          >
            <Input
              className="max-w-xs"
              aria-label="Ollama embedding model"
              disabled={form.formLocked}
              defaultValue={codeIndex.ollamaModel}
              key={`ci-ollama-${codeIndex.ollamaModel}`}
              onBlur={(e) => {
                const v = e.target.value.trim() || 'nomic-embed-text'
                if (v !== codeIndex.ollamaModel) patchCodeIndex({ ollamaModel: v })
              }}
            />
          </SettingsField>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Index status">
        <SettingsField
          id="codeindex-status"
          title="Index status"
          hint="Live walk / hash / embed progress for the local semantic and sparse indexes."
          help="Scanned counts every walked path. Updated / unchanged apply only to text files that are content-hashed. Non-text and oversized files are skipped without those counters."
          wide
        >
          <div className="flex flex-col items-start gap-2">
            <IndexProgressPanel status={runtime} />
            {runtime?.error ? (
              <p className="m-0 w-full text-xs text-danger" role="alert">
                {runtime.error}
              </p>
            ) : null}
            {statusError ? (
              <p className="m-0 w-full text-xs text-danger" role="alert">
                {statusError}
              </p>
            ) : null}
            <Button
              type="button"
              variant="subtle"
              disabled={form.formLocked || reindexBusy || !codeIndex.enabled}
              onClick={() => {
                setReindexBusy(true)
                setStatusError(null)
                void window.vyotiq
                  .codeIndexReindex()
                  .then((res) => {
                    if (!res.ok) {
                      setStatusError(res.error ?? 'Reindex failed')
                      return
                    }
                    refreshStatus()
                  })
                  .finally(() => setReindexBusy(false))
              }}
            >
              {reindexBusy ? 'Reindexing…' : 'Reindex workspace'}
            </Button>
          </div>
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Process memory">
        <SettingsField
          id="process-metrics"
          title="Live processes"
          hint="Chromium working set plus the ONNX embed utility. Matches Task Manager’s combined Electron RSS."
          help="Main is the Browser process. Tabs include the app renderer and any DevTools or agent-browser views. Embed is the code-index ONNX child."
          wide
        >
          <p className="m-0 text-xs text-secondary">
            {processMetrics ? processMetricsLabel(processMetrics) : 'Sampling…'}
          </p>
        </SettingsField>
      </SettingsGroup>
    </SettingsStack>
  )
}
