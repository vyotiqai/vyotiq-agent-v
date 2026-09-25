import { useState, type DragEvent, type ReactNode } from 'react'
import type { ToolApprovalMode } from '@shared/ipc'
import { VyotiqMark } from '@renderer/lib/brand'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn } from '@renderer/lib/ui'
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

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

/** What would change the provider check's answer. */
function connectionKey(settings: SetupProviderSettings, secrets: Record<string, boolean>): string {
  return [settings.ollamaBaseUrl, settings.customOpenAiBaseUrl, secrets[settings.provider] ? 'key' : ''].join('|')
}

/**
 * First run: three steps — a model, a folder, what needs your OK — then the
 * first task. Each step reads the real setting and writes it where Settings
 * does; nothing here is a copy of its own.
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
  onStart
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
          : `Starts in ${formatWorkspaceName(workspace)}`

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto" data-setup>
      <div className="mx-auto w-full max-w-[640px] px-8 pb-12 pt-12">
        <VyotiqMark size={26} className="text-fg-strong" decorative />
        <h1 className="mt-5 text-display font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">Set up Agent V</h1>
        <p className="mt-1 text-sm text-muted">
          Three things, then hand it its first task. Everything here can change later in Settings.
        </p>

        <ol className="mt-8 divide-y divide-border border-y border-border">
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
              <div className="mt-3">
                <Button variant="primary" size="sm" icon="key" onClick={onChangeProvider}>
                  Add a key or choose a provider
                </Button>
              </div>
            ) : provider.state === 'failed' ? (
              <>
                <p className="mt-1 text-xs leading-[18px] text-tertiary" data-setup-provider-reason>
                  {provider.reason}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button variant="primary" size="sm" icon="retry" onClick={recheck}>
                    Check again
                  </Button>
                  <Button variant="ghost" size="sm" onClick={onChangeProvider}>
                    Choose a provider
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
            onChange={() => void run(onChooseFolder)}
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
            icon="play"
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
            Start your first task
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
