import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import type { ProviderId, SetupDetection, SetupLocalServer, ToolApprovalMode } from '@shared/ipc'
import { providerLabel } from '@shared/providers'
import { VyotiqMark } from '@renderer/lib/brand'
import { Icon } from '@renderer/lib/icons'
import { ActionMenu, Button, Input, StatusGlyph, cn } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { ApprovalModeChoice } from './ApprovalModeChoice'
import { providerConfigured, setupProvider, type SetupProviderSettings } from './setupModel'
import { useProviderCheck } from './useProviderCheck'

type StepState = 'done' | 'current' | 'queued'

function SetupStep({
  n,
  state,
  title,
  summary,
  live,
  onChange,
  changeLabel,
  children
}: {
  n: number
  state: StepState
  title: string
  summary: ReactNode
  /** Read the summary out when it changes — a check finishing, say. */
  live?: boolean
  onChange?: () => void
  changeLabel?: string
  children?: ReactNode
}) {
  return (
    <li className="py-4" data-setup-step={n} data-state={state}>
      <div className="flex items-center gap-3">
        {state === 'done' ? (
          <StatusGlyph state="review" size={18} label />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              'grid size-[18px] shrink-0 place-items-center rounded-full border font-mono text-caption',
              state === 'current' ? 'border-accent text-accent' : 'border-border-strong text-tertiary'
            )}
          >
            {n}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 className={cn('text-sm font-medium', state === 'queued' ? 'text-muted' : 'text-fg-strong')}>{title}</h2>
          <div className="truncate text-xs text-muted" aria-live={live ? 'polite' : undefined}>
            {summary}
          </div>
        </div>
        {state === 'done' && onChange ? (
          <Button size="xs" variant="ghost" onClick={onChange} aria-label={changeLabel}>
            Change
          </Button>
        ) : null}
      </div>
      {state !== 'done' && children ? <div className="pl-[30px]">{children}</div> : null}
    </li>
  )
}

/**
 * Providers a key can be pasted for right here, OpenCode Go first as in
 * Settings. Custom endpoints, Bedrock, Vertex and Azure need more than a key,
 * so "More providers in Settings" stays beside this.
 */
const KEY_PROVIDERS: readonly ProviderId[] = ['opencode', 'anthropic', 'openai', 'openrouter', 'gemini', 'deepseek', 'groq', 'xai', 'mistral']

/**
 * The provider step's own ways in: a key already in the environment, a model
 * server already running here, or a key pasted for a provider picked here.
 * Settings keeps every other provider and option.
 */
function ConnectHere({
  onUseEnvKey,
  onUseLocal,
  onSaveKey,
  onCloudAccount
}: {
  onUseEnvKey: (provider: ProviderId) => Promise<string | null>
  onUseLocal: (server: SetupLocalServer) => Promise<string | null>
  onSaveKey: (provider: ProviderId, key: string) => Promise<string | null>
  /** Bedrock, Vertex and Azure sign in with more than a key: Settings. */
  onCloudAccount: () => void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const [localUrl, setLocalUrl] = useState('http://localhost:1234/v1')
  const [found, setFound] = useState<SetupDetection | null>(null)
  const [pick, setPick] = useState<ProviderId>('anthropic')
  const [pickOpen, setPickOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void window.vyotiq?.setupDetect?.().then((res) => {
      if (res?.ok) setFound(res.data)
    })
  }, [])
  const act = async (id: string, run: () => Promise<string | null>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      setError(await run())
    } finally {
      setBusy(null)
    }
  }
  const offers = (found?.envKeys.length ?? 0) + (found?.local.length ?? 0)
  return (
    <div className="mt-3 space-y-3" data-setup-connect>
      {offers > 0 ? (
        <div>
          <div className={cn('mb-1', SECTION_LABEL)}>Found on this computer</div>
          <ul className="m-0 list-none p-0">
            {found!.envKeys.map((entry) => (
              <li key={entry.provider} className="flex h-9 items-center gap-2 text-sm" data-setup-env-key={entry.provider}>
                <Icon name="key" size={14} className="shrink-0 text-muted" />
                <span className="text-fg">{providerLabel(entry.provider)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-caption text-tertiary">{entry.envVar}</span>
                <Button
                  size="xs"
                  variant="secondary"
                  pending={busy === entry.provider}
                  disabled={busy !== null}
                  onClick={() => void act(entry.provider, () => onUseEnvKey(entry.provider))}
                >
                  Use this key
                </Button>
              </li>
            ))}
            {found!.local.map((server) => (
              <li key={server.id} className="flex h-9 items-center gap-2 text-sm" data-setup-local={server.id}>
                <Icon name="cpu" size={14} className="shrink-0 text-muted" />
                <span className="text-fg">{server.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-tertiary">
                  {server.models.length === 0
                    ? 'running, no models yet'
                    : `running · ${server.models.length} model${server.models.length === 1 ? '' : 's'}`}
                </span>
                <Button
                  size="xs"
                  variant="secondary"
                  pending={busy === server.id}
                  disabled={busy !== null || server.models.length === 0}
                  onClick={() => void act(server.id, () => onUseLocal(server))}
                >
                  Use it
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <form
        className="flex items-center gap-2"
        aria-label="Paste an API key"
        onSubmit={(e) => {
          e.preventDefault()
          const value = key.trim()
          if (!value) return
          void act('paste', async () => {
            const failed = await onSaveKey(pick, value)
            if (!failed) setKey('')
            return failed
          })
        }}
      >
        <ActionMenu
          aria-label="Provider for the key"
          open={pickOpen}
          onOpenChange={setPickOpen}
          placement="down"
          align="start"
          items={KEY_PROVIDERS.map((id) => ({ id, label: providerLabel(id), checked: id === pick, onSelect: () => setPick(id) }))}
          trigger={(t) => (
            <Button
              ref={t.ref}
              size="sm"
              variant="secondary"
              trailingIcon="chevron"
              aria-expanded={t['aria-expanded']}
              aria-controls={t['aria-controls']}
              aria-haspopup={t['aria-haspopup']}
              onClick={t.onClick}
            >
              {providerLabel(pick)}
            </Button>
          )}
        />
        <div className="min-w-0 flex-1">
          <Input
            size="sm"
            mono
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${providerLabel(pick)} API key`}
            placeholder="Paste an API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </div>
        <Button size="sm" variant="primary" type="submit" pending={busy === 'paste'} disabled={busy !== null || !key.trim()}>
          Save
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2" data-setup-other-ways>
        <Button size="sm" variant="ghost" icon="cpu" aria-expanded={localOpen} onClick={() => setLocalOpen((v) => !v)}>
          Local server (LM Studio, llama.cpp, vLLM)…
        </Button>
        <Button size="sm" variant="ghost" icon="cloud" onClick={onCloudAccount}>
          Cloud account (Bedrock, Vertex, Azure)…
        </Button>
      </div>
      {localOpen ? (
        <form
          className="flex items-center gap-2"
          aria-label="Connect a local server"
          onSubmit={(e) => {
            e.preventDefault()
            const url = localUrl.trim()
            if (!url) return
            void act('local-url', () => onUseLocal({ id: 'lmstudio', name: 'Local server', baseUrl: url, models: [] }))
          }}
        >
          <div className="min-w-0 flex-1">
            <Input
              size="sm"
              mono
              aria-label="Local server URL"
              placeholder="http://localhost:1234/v1"
              value={localUrl}
              onChange={(e) => setLocalUrl(e.target.value)}
            />
          </div>
          <Button size="sm" variant="primary" type="submit" pending={busy === 'local-url'} disabled={busy !== null || !localUrl.trim()}>
            Connect
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/** What would change the provider check's answer. */
function connectionKey(settings: SetupProviderSettings, secrets: Record<string, boolean>): string {
  return [settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, secrets[settings.provider] ? 'key' : ''].join('|')
}

/**
 * What Start does once the approval choice is saved: open the first task's
 * brief, a new task's brief, or send the instruction a send was held back for.
 */
export type SetupNext = 'first-task' | 'task' | 'send'

const START_LABEL: Record<SetupNext, string> = {
  'first-task': 'Start your first task',
  task: 'Start a task',
  send: 'Send your instruction'
}

const INTRO: Record<SetupNext, string> = {
  'first-task': 'Three things, then hand it its first task. Everything here can change later in Settings.',
  task: 'Decide what needs your OK before the agent runs tools. Everything here can change later in Settings.',
  send: 'Your instruction waits here until you decide what needs your OK. Everything here can change later in Settings.'
}

/**
 * Three steps — a model, a folder, what needs your OK — then a task. A first
 * run lands on it; anyone else who has never made the approval choice meets it
 * on Home or at their first send, with the steps they already have shown done.
 * Each step reads the real setting and writes it where Settings does; nothing
 * here is a copy of its own.
 */
export function SetupPage({
  settings,
  secrets,
  workspace,
  recents,
  approvalMode,
  mcpProtection,
  onChangeProvider,
  onChooseFolder,
  onOpenPath,
  onStart,
  onUseEnvKey,
  onUseLocal,
  onSaveKey,
  next = 'first-task'
}: {
  settings: SetupProviderSettings
  /** Which providers have a saved key. */
  secrets: Record<string, boolean>
  /** The workspace in front — the one a folder opened here becomes — or null. */
  workspace: string | null
  recents: readonly string[]
  /** The choice it starts on. */
  approvalMode: ToolApprovalMode
  mcpProtection: boolean
  onChangeProvider: () => void
  /** The folder picker. Resolves to an error message, or null. */
  onChooseFolder: () => Promise<string | null>
  /** Open a folder by path — a recent one or a dropped one. Resolves to an error message, or null. */
  onOpenPath: (path: string) => Promise<string | null>
  /** Resolves to why the choice could not be saved, or null once the brief opens. */
  onStart: (workspacePath: string, mode: ToolApprovalMode) => Promise<string | null>
  /** Use a key found in the environment; resolves to an error, or null. */
  onUseEnvKey?: (provider: ProviderId) => Promise<string | null>
  /** Use a model server running on this machine. */
  onUseLocal?: (server: SetupLocalServer) => Promise<string | null>
  /** Save a pasted key and switch to its provider. */
  onSaveKey?: (provider: ProviderId, key: string) => Promise<string | null>
  next?: SetupNext
}): ReactNode {
  const [mode, setMode] = useState<ToolApprovalMode>(approvalMode)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const { check, recheck } = useProviderCheck(
    settings.provider,
    providerConfigured(settings, secrets),
    connectionKey(settings, secrets)
  )
  const provider = setupProvider(settings, secrets, check)
  const ready = provider.ready && workspace != null

  const run = async (open: () => Promise<string | null>): Promise<void> => {
    setFolderError(null)
    setFolderError(await open())
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    setDropping(false)
    const file = e.dataTransfer.files[0]
    const path = file ? window.vyotiq?.pathForFile?.(file) : ''
    if (!path) {
      setFolderError('That can’t be opened as a folder.')
      return
    }
    void run(() => onOpenPath(path))
  }

  const hint =
    provider.state === 'checking'
      ? `Checking ${provider.label}…`
      : !provider.ready
        ? 'Connect a provider first'
        : workspace == null
          ? 'Open a workspace first'
          : `${next === 'send' ? 'Sends' : 'Starts'} in ${formatWorkspaceName(workspace)}`

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto" data-setup>
      <div className="mx-auto w-full max-w-[640px] px-8 pb-12 pt-12">
        <VyotiqMark size={28} className="text-fg-strong" decorative />
        <h1 className="mt-5 text-display font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">Set up Agent V</h1>
        <p className="mt-1 text-sm text-muted">{INTRO[next]}</p>

        <ol className="mt-8 divide-y divide-border/60 border-y border-border">
          <SetupStep
            n={1}
            state={provider.ready ? 'done' : 'current'}
            title="Connect a model provider"
            summary={`${provider.label} · ${provider.detail}`}
            live
            onChange={onChangeProvider}
            changeLabel="Change the model provider"
          >
            {provider.state === 'missing_key' ? (
              <>
                {onUseEnvKey && onUseLocal && onSaveKey ? (
                  <ConnectHere onUseEnvKey={onUseEnvKey} onUseLocal={onUseLocal} onSaveKey={onSaveKey} onCloudAccount={onChangeProvider} />
                ) : null}
                <div className="mt-3">
                  <Button variant="ghost" size="sm" icon="gear" onClick={onChangeProvider}>
                    More providers in Settings
                  </Button>
                </div>
              </>
            ) : provider.state === 'failed' ? (
              // Usually the default Ollama, which nobody chose and is not
              // running: why stays quiet, and pasting a key comes first —
              // "Check again" as the primary button sent most people nowhere.
              <>
                <p className="mt-1 text-xs leading-[18px] text-tertiary" data-setup-provider-reason>
                  {provider.reason}
                </p>
                {onUseEnvKey && onUseLocal && onSaveKey ? (
                  <ConnectHere onUseEnvKey={onUseEnvKey} onUseLocal={onUseLocal} onSaveKey={onSaveKey} onCloudAccount={onChangeProvider} />
                ) : null}
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="ghost" size="sm" icon="retry" onClick={recheck}>
                    Check {provider.label} again
                  </Button>
                  <Button variant="ghost" size="sm" icon="gear" onClick={onChangeProvider}>
                    More providers in Settings
                  </Button>
                </div>
              </>
            ) : null}
          </SetupStep>

          <SetupStep
            n={2}
            state={workspace ? 'done' : provider.ready ? 'current' : 'queued'}
            title="Open a workspace"
            summary={
              workspace ? (
                <span className="font-mono text-caption">{workspace}</span>
              ) : (
                'The folder the agent works in. Its file tools stay inside it.'
              )
            }
            // A held instruction belongs to the folder it was written in.
            onChange={next === 'send' ? undefined : () => void run(onChooseFolder)}
            changeLabel="Open another folder"
          >
            <div
              className={cn('-mx-2 -mb-2 mt-2 rounded-md px-2 pb-2 pt-1', dropping ? 'bg-surface' : '')}
              onDragOver={(e) => {
                if (!hasFiles(e)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropping(true)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
              }}
              onDrop={onDrop}
              data-setup-drop
            >
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" icon="folderOpen" onClick={() => void run(onChooseFolder)}>
                  Choose a folder…
                </Button>
                <span className="text-xs text-tertiary">or drop one here</span>
              </div>
              {folderError ? (
                <p role="alert" className="mt-2 text-xs text-danger">
                  {folderError}
                </p>
              ) : null}
              {recents.length > 0 ? (
                <div className="mt-3">
                  <div className={cn('mb-1', SECTION_LABEL)}>Recent</div>
                  {recents.map((path) => (
                    <button
                      key={path}
                      type="button"
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring"
                      onClick={() => void run(() => onOpenPath(path))}
                    >
                      <Icon name="workspace" size={14} className="shrink-0 text-muted" />
                      <span className="shrink-0 text-sm text-fg">{formatWorkspaceName(path)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-caption text-tertiary">{path}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </SetupStep>

          <SetupStep
            n={3}
            state={ready ? 'current' : 'queued'}
            title="Decide what needs your OK"
            summary="You can change this per workspace."
          >
            <div className="mt-2">
              <ApprovalModeChoice value={mode} onChange={setMode} mcpProtection={mcpProtection} />
            </div>
          </SetupStep>
        </ol>

        <div className="mt-8 flex items-center gap-3">
          <Button
            variant="primary"
            size="md"
            icon={next === 'send' ? 'send' : 'play'}
            disabled={!ready || starting}
            pending={starting}
            onClick={() => {
              if (!workspace) return
              setStarting(true)
              setStartError(null)
              void onStart(workspace, mode)
                .then((error) => setStartError(error))
                .finally(() => setStarting(false))
            }}
          >
            {START_LABEL[next]}
          </Button>
          <span className="text-xs text-tertiary">{hint}</span>
        </div>
        {startError ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            Couldn’t save your approval choice: {startError}
          </p>
        ) : null}
      </div>
    </div>
  )
}
