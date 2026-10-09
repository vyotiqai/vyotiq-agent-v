import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DetectedMcpServer, McpApplyDetectedRequest, McpDetectResult, McpRegistryServer, McpTransport } from '@shared/ipc'
import type { MarketplaceOverrideKind } from '@shared/domain/marketplaceEnablement'
import { classifyMcpInput, tokenizeCommand } from '@shared/utils/mcpClassify'
import { Dialog } from '@renderer/lib/a11y/Dialog'
import { Button, Checkbox, Input, Segmented, StatusGlyph, Textarea, type TaskState } from '@renderer/lib/ui'
import { FIELD_GRID } from './McpServerConfig'
import { mcpLaunchLine } from './extensionItems'
import type { MarketplaceController } from './useMarketplaceController'

const DETECT_DEBOUNCE_MS = 300

const OVERRIDE_KIND: Record<'mcp' | 'skill' | 'plugin', MarketplaceOverrideKind> = {
  mcp: 'mcp',
  skill: 'skills',
  plugin: 'plugins'
}

/** Quote a token so `tokenizeCommand` gives it back whole. */
function quoteToken(token: string): string {
  if (token && !/[\s"']/.test(token)) return token
  if (!token.includes('"')) return `"${token}"`
  if (!token.includes("'")) return `'${token}'`
  return token
}

export function argsToLine(args: readonly string[] | undefined): string {
  return (args ?? []).map(quoteToken).join(' ')
}

export function envToLine(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => quoteToken(`${key}=${value}`))
    .join(' ')
}

export function lineToEnv(line: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const token of tokenizeCommand(line)) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    env[token.slice(0, eq)] = token.slice(eq + 1)
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function detectedWhat(result: McpDetectResult, server: DetectedMcpServer | null, found: number): string {
  switch (result.kind) {
    case 'remote':
      return `Detected a remote ${server?.transport === 'sse' ? 'SSE' : 'HTTP'} server`
    case 'stdio':
      return 'Detected a stdio server'
    case 'npm':
      return 'Detected an npm package'
    case 'json':
      return found > 1 ? `Found ${found} servers` : 'Detected a server config'
    case 'git':
      return 'Detected a git repository'
    case 'vyotiq-package':
      return 'Detected an Agent V package'
    default:
      return 'Not recognised'
  }
}

type Detection =
  | { phase: 'idle' }
  | { phase: 'git' }
  | { phase: 'detecting' }
  | { phase: 'error'; error: string }
  | { phase: 'done'; result: McpDetectResult }

/** The servers a config holds, each ticked to be imported. */
function useImportList() {
  const [preview, setPreview] = useState<DetectedMcpServer[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [warnings, setWarnings] = useState<string[]>([])
  const set = useCallback((next: DetectedMcpServer[] | null, nextWarnings: string[] = []) => {
    setPreview(next)
    setSelected(new Set((next ?? []).map((s) => s.id)))
    setWarnings(nextWarnings)
  }, [])
  const toggle = useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  return { preview, selected, warnings, set, toggle }
}

type ImportList = ReturnType<typeof useImportList>

export function AddMcpDialog({
  controller,
  onClose,
  onAdded,
  onUseCatalog
}: {
  controller: MarketplaceController
  onClose: () => void
  /** The list key of what was added, to select it. */
  onAdded: (key: string | null) => void
  /** Show a catalog package that runs the same server. */
  onUseCatalog: (catalogId: string) => void
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [view, setView] = useState<'paste' | 'import' | 'registry'>('paste')
  /** Environment names a registry pick needs, filled into Environment once detected. */
  const pendingEnvRef = useRef<string[] | null>(null)
  const [input, setInput] = useState('')
  const [detection, setDetection] = useState<Detection>({ phase: 'idle' })
  const [server, setServer] = useState<DetectedMcpServer | null>(null)
  const [serverDirty, setServerDirty] = useState(false)
  const [argsLine, setArgsLine] = useState('')
  const [envLine, setEnvLine] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [workspaceOnly, setWorkspaceOnly] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const pasted = useImportList()
  const scanned = useImportList()
  const [scanning, setScanning] = useState(false)
  const detectReqRef = useRef(0)
  const resetPasted = pasted.set

  const locked = controller.formLocked || submitting

  const accept = useCallback((result: McpDetectResult): void => {
    setDetection({ phase: 'done', result })
    setServer(result.server ?? null)
    setArgsLine(argsToLine(result.server?.args))
    const pending = pendingEnvRef.current
    pendingEnvRef.current = null
    const known = envToLine(result.server?.env)
    setEnvLine(pending && pending.length > 0 ? [known, ...pending.map((name) => `${name}=`)].filter(Boolean).join(' ') : known)
    setServerDirty(false)
    setOverwrite(false)
  }, [])

  const runDetect = useCallback(async (text: string, acknowledge: boolean): Promise<void> => {
    const reqId = ++detectReqRef.current
    setDetection({ phase: 'detecting' })
    const res = await controller.detectMcp(text, { acknowledge })
    if (reqId !== detectReqRef.current) return
    if (!res.ok) {
      setDetection({ phase: 'error', error: res.error })
      return
    }
    accept(res.data)
    // A config can hold several servers; list them all rather than the first.
    if (res.data.kind === 'json') {
      const all = await controller.scanExternalMcp({ json: text })
      if (reqId !== detectReqRef.current) return
      resetPasted(all.ok && all.data.preview.length > 1 ? all.data.preview : null)
    } else {
      resetPasted(null)
    }
  }, [controller, resetPasted, accept])
  const runDetectRef = useRef(runDetect)
  runDetectRef.current = runDetect

  // Everything but a git URL is parsed in place, so it is detected as it is
  // typed. A git URL is cloned to look inside, so it waits for Detect.
  useEffect(() => {
    const text = input.trim()
    setError(null)
    if (!text) {
      detectReqRef.current++
      setDetection({ phase: 'idle' })
      setServer(null)
      resetPasted(null)
      return
    }
    if (classifyMcpInput(text) === 'git') {
      detectReqRef.current++
      setDetection({ phase: 'git' })
      setServer(null)
      resetPasted(null)
      return
    }
    const timer = window.setTimeout(() => void runDetectRef.current(text, false), DETECT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [input, resetPasted])

  const patch = (next: Partial<DetectedMcpServer>): void => {
    setServer((prev) => (prev ? { ...prev, ...next } : prev))
    setServerDirty(true)
  }

  const result = detection.phase === 'done' ? detection.result : null
  const packageInstall =
    result?.install && result.kind === 'vyotiq-package' && !serverDirty ? result.install : undefined
  const preferInstall = Boolean(result?.install) && (result?.kind === 'vyotiq-package' ? !serverDirty : !server)
  const many = pasted.preview && pasted.preview.length > 1 ? pasted.preview : null
  const transport: McpTransport = server?.transport ?? 'stdio'
  const remote = transport === 'http' || transport === 'sse'
  const hasLaunch = Boolean((server?.command ?? '').trim() || (server?.url ?? '').trim())
  const duplicateBlocks = Boolean(result?.duplicate) && !overwrite && !packageInstall
  const canAdd = many
    ? pasted.selected.size > 0
    : Boolean(result) && (preferInstall || (Boolean(server) && hasLaunch)) && !duplicateBlocks

  const finishWorkspaceOnly = async (key: string, kind: MarketplaceOverrideKind, id: string): Promise<string> => {
    if (workspaceOnly) await controller.setWorkspaceOverride(kind, id, true)
    return key
  }

  const add = async (): Promise<void> => {
    if (!result) return
    setError(null)
    setSubmitting(true)
    try {
      if (many) {
        const servers = many.filter((s) => pasted.selected.has(s.id))
        const res = await controller.importExternalMcp({ mode: 'merge', selectedIds: [...pasted.selected], servers })
        if (!res.ok) {
          setError(res.error)
          return
        }
        onAdded(servers.length === 1 ? `server:${servers[0]!.id}` : null)
        return
      }
      const payload: McpApplyDetectedRequest =
        preferInstall && result.install
          ? { install: result.install, overwrite: false }
          : {
              server: server
                ? {
                    ...server,
                    name: server.name.trim() || server.id,
                    ...(remote ? {} : { args: tokenizeCommand(argsLine), env: lineToEnv(envLine) }),
                    // Only here: off everywhere, then on in this workspace.
                    enabled: !workspaceOnly
                  }
                : undefined,
              overwrite
            }
      const res = await controller.applyDetectedMcp(payload)
      if (!res.ok) {
        setError(res.error)
        return
      }
      const item = res.data.installResult?.item
      if (item) {
        if (workspaceOnly) await controller.setEnabled(item, false)
        onAdded(await finishWorkspaceOnly(`${item.kind}:${item.id}`, OVERRIDE_KIND[item.kind], item.id))
      } else if (res.data.serverId) {
        onAdded(await finishWorkspaceOnly(`server:${res.data.serverId}`, 'mcp', res.data.serverId))
      } else {
        onAdded(null)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const scan = async (paths?: string[]): Promise<void> => {
    setScanning(true)
    setError(null)
    try {
      const res = await controller.scanExternalMcp({ paths })
      if (!res.ok) {
        setError(res.error)
        return
      }
      scanned.set(res.data.preview, res.data.warnings)
    } finally {
      setScanning(false)
    }
  }

  const chooseConfig = async (): Promise<void> => {
    const pick = await window.vyotiq.marketplacePickLocal()
    if (!pick.ok) {
      setError(pick.error)
      return
    }
    if (pick.data) await scan([pick.data])
  }

  const openImport = (): void => {
    setView('import')
    setError(null)
    if (!scanned.preview) void scan()
  }

  const importSelected = async (): Promise<void> => {
    const list = scanned.preview ?? []
    const servers = list.filter((s) => scanned.selected.has(s.id))
    setError(null)
    setSubmitting(true)
    try {
      const res = await controller.importExternalMcp({ mode: 'merge', selectedIds: [...scanned.selected], servers })
      if (!res.ok) {
        setError(res.error)
        return
      }
      onAdded(servers.length === 1 ? `server:${servers[0]!.id}` : null)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={view === 'paste' ? 'Add an MCP server' : view === 'registry' ? 'Search the MCP Registry' : 'Import MCP servers'}
      icon="mcp"
      useNativeDialog={false}
      padded={false}
      initialFocusRef={inputRef}
      className="vy-menu flex w-[560px] flex-col overflow-hidden"
    >
      {view === 'paste' ? (
        <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <label className="text-xs font-medium text-fg" htmlFor="mcp-src">
              Paste a URL, npm package, npx command or JSON
            </label>
            <Textarea
              ref={inputRef}
              id="mcp-src"
              size="sm"
              mono
              rows={2}
              value={input}
              // Only this dialog's own submit locks what you type. The JSON
              // preview scan sets the marketplace's busy lock, which disabled
              // the field mid-typing and dropped its focus.
              disabled={submitting}
              placeholder="npx -y @modelcontextprotocol/server-memory"
              className="mt-1.5"
              onChange={(e) => setInput(e.target.value)}
            />
          </div>

          {detection.phase === 'idle' ? null : (
            <div>
              <DetectionLine
                detection={detection}
                server={server}
                found={many?.length ?? 0}
                locked={locked}
                onDetectGit={() => void runDetect(input.trim(), true)}
                onUseCatalog={onUseCatalog}
              />
              {result?.warnings.map((w) => (
                <p key={w} className="text-xs text-muted [overflow-wrap:anywhere]">
                  {w}
                </p>
              ))}
              {many ? (
                <ServerChecklist list={pasted} disabled={locked} />
              ) : server && !(preferInstall && packageInstall) ? (
                <div className={`mt-2 ${FIELD_GRID}`}>
                  <span className="text-muted">Name</span>
                  <Input size="sm" aria-label="Server name" value={server.name} disabled={locked} onChange={(e) => patch({ name: e.target.value })} />
                  {remote ? (
                    <>
                      <span className="text-muted">URL</span>
                      <Input size="sm" mono aria-label="Server URL" value={server.url ?? ''} disabled={locked} onChange={(e) => patch({ url: e.target.value })} />
                      <span className="text-muted">Transport</span>
                      <div>
                        <Segmented
                          label="Server transport"
                          value={transport}
                          disabled={locked}
                          items={[
                            { id: 'http', label: 'HTTP' },
                            { id: 'sse', label: 'SSE' }
                          ]}
                          onChange={(next) => patch({ transport: next })}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="text-muted">Command</span>
                      <Input size="sm" mono aria-label="Server command" value={server.command ?? ''} disabled={locked} onChange={(e) => patch({ command: e.target.value })} />
                      <span className="text-muted">Arguments</span>
                      <Input
                        size="sm"
                        mono
                        aria-label="Server arguments"
                        value={argsLine}
                        disabled={locked}
                        onChange={(e) => {
                          setArgsLine(e.target.value)
                          setServerDirty(true)
                        }}
                      />
                      <span className="text-muted">Env</span>
                      <Input
                        size="sm"
                        mono
                        aria-label="Server environment"
                        placeholder="KEY=value"
                        value={envLine}
                        disabled={locked}
                        onChange={(e) => {
                          setEnvLine(e.target.value)
                          setServerDirty(true)
                        }}
                      />
                    </>
                  )}
                </div>
              ) : null}
              {packageInstall && preferInstall ? (
                <p className="mt-2 text-xs text-muted">Adding installs it as a package from {packageInstall.target}.</p>
              ) : null}
            </div>
          )}

          {result?.duplicate && !packageInstall && !many ? (
            <Checkbox
              checked={overwrite}
              disabled={locked}
              onCheckedChange={setOverwrite}
              label="Replace the server already added with this id"
            />
          ) : null}
          {many ? null : (
            <Checkbox
              checked={workspaceOnly}
              disabled={locked || !controller.canOverrideWorkspace}
              title={controller.canOverrideWorkspace ? undefined : 'Open a workspace first.'}
              onCheckedChange={setWorkspaceOnly}
              label="Available in this workspace only"
            />
          )}
          {error ? <ErrorLine>{error}</ErrorLine> : null}
        </div>
      ) : view === 'registry' ? (
        <McpRegistrySearch
          disabled={locked}
          onPick={(picked) => {
            pendingEnvRef.current = picked.env.filter((v) => v.required).map((v) => v.name)
            setView('paste')
            setInput(picked.launch)
          }}
        />
      ) : (
        <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-4">
          <p className="text-xs text-muted">
            MCP servers in the Cursor and Claude Desktop configs on this machine. Imported servers are
            added to every workspace.
          </p>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" icon="retry" pending={scanning} disabled={locked} onClick={() => void scan()}>
              Scan again
            </Button>
            <Button size="sm" variant="ghost" icon="folderOpen" disabled={locked || scanning} onClick={() => void chooseConfig()}>
              Choose config file…
            </Button>
          </div>
          {scanned.warnings.map((w) => (
            <p key={w} className="text-xs text-muted [overflow-wrap:anywhere]">
              {w}
            </p>
          ))}
          {scanning && !scanned.preview ? (
            <p role="status" className="text-xs text-muted">
              Reading configs…
            </p>
          ) : scanned.preview && scanned.preview.length === 0 ? (
            <p className="text-xs text-muted">No MCP servers found in those configs.</p>
          ) : scanned.preview ? (
            <ServerChecklist list={scanned} disabled={locked} />
          ) : null}
          {error ? <ErrorLine>{error}</ErrorLine> : null}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          className="rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
          onClick={view === 'paste' ? openImport : () => setView('paste')}
        >
          {view === 'paste' ? 'Import from Cursor or Claude…' : 'Paste one instead'}
        </button>
        {view === 'paste' ? (
          <button
            type="button"
            className="rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
            onClick={() => {
              setError(null)
              setView('registry')
            }}
          >
            Search the MCP Registry…
          </button>
        ) : null}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {view === 'registry' ? null : view === 'paste' ? (
          <Button size="sm" variant="primary" pending={submitting} disabled={locked || !canAdd} onClick={() => void add()}>
            {many ? `Import ${pasted.selected.size}` : 'Add and connect'}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            pending={submitting}
            disabled={locked || scanned.selected.size === 0}
            onClick={() => void importSelected()}
          >
            Import {scanned.selected.size || ''}
          </Button>
        )}
      </div>
    </Dialog>
  )
}

/**
 * The official MCP Registry, searched as you type. Picking a server hands its
 * launch line to the paste view, where it is detected and reviewed like
 * anything pasted; nothing runs from here.
 */
function McpRegistrySearch({ disabled, onPick }: { disabled: boolean; onPick: (server: McpRegistryServer) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<McpRegistryServer[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const seqRef = useRef(0)
  const searchRef = useRef<HTMLInputElement>(null)
  // Opening the search is asking to type in it.
  useEffect(() => {
    searchRef.current?.focus()
  }, [])
  useEffect(() => {
    const seq = ++seqRef.current
    const timer = window.setTimeout(() => {
      setSearching(true)
      void window.vyotiq.mcpRegistrySearch(query).then((res) => {
        if (seq !== seqRef.current) return
        setSearching(false)
        if (res.ok) {
          setResults(res.data)
          setFailure(null)
        } else {
          setFailure(res.error)
        }
      })
    }, query ? DETECT_DEBOUNCE_MS : 0)
    return () => window.clearTimeout(timer)
  }, [query])
  return (
    <div className="min-h-0 space-y-3 overflow-y-auto px-4 py-4" data-mcp-registry>
      <Input
        size="sm"
        ref={searchRef}
        placeholder="Search servers: postgres, github, docker…"
        aria-label="Search the MCP Registry"
        value={query}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
      />
      <p className="m-0 text-xs text-muted">
        From registry.modelcontextprotocol.io. Anyone can publish there: read what a server runs before you add it.
      </p>
      {failure ? <ErrorLine>{failure}</ErrorLine> : null}
      {searching && !results ? (
        <p role="status" className="m-0 text-xs text-muted">
          Searching…
        </p>
      ) : results && results.length === 0 ? (
        <p className="m-0 text-xs text-muted">No servers Agent V can launch match that.</p>
      ) : results ? (
        <ul className="m-0 list-none divide-y divide-border/60 border-y border-border p-0">
          {results.map((server) => (
            <li key={server.name}>
              <button
                type="button"
                disabled={disabled}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 rounded-sm px-1 py-2 text-left hover:bg-surface focus-visible:vy-focus-ring"
                onClick={() => onPick(server)}
              >
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm text-fg">{server.title ?? server.name}</span>
                  {server.version ? <span className="shrink-0 font-mono text-caption text-tertiary">{server.version}</span> : null}
                  <span className="flex-1" />
                  <span className="shrink-0 text-caption text-tertiary">{server.remote ? 'Remote' : 'Local'}</span>
                </span>
                {server.description ? <span className="line-clamp-2 text-xs text-muted">{server.description}</span> : null}
                <span className="max-w-full truncate font-mono text-caption text-tertiary">{server.launch}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-danger [overflow-wrap:anywhere]">
      {children}
    </p>
  )
}

function DetectionLine({
  detection,
  server,
  found,
  locked,
  onDetectGit,
  onUseCatalog
}: {
  detection: Detection
  server: DetectedMcpServer | null
  found: number
  locked: boolean
  onDetectGit: () => void
  onUseCatalog: (catalogId: string) => void
}) {
  let glyph: TaskState
  let what: string
  let tail: ReactNode = null
  switch (detection.phase) {
    case 'git':
      glyph = 'queued'
      what = 'A git repository'
      tail = (
        <>
          <span className="text-muted">· detecting clones it to look inside</span>
          <span className="flex-1" />
          <Button size="xs" variant="secondary" disabled={locked} onClick={onDetectGit}>
            Detect
          </Button>
        </>
      )
      break
    case 'detecting':
      glyph = 'running'
      what = 'Detecting…'
      break
    case 'error':
      glyph = 'failed'
      what = detection.error
      break
    case 'done': {
      const r = detection.result
      glyph = r.confidence === 'low' ? 'needs' : 'review'
      what = detectedWhat(r, server, found)
      tail = (
        <span className="min-w-0 text-muted">
          · {r.confidence} confidence
          {r.duplicate ? ' · already added' : ''}
          {r.catalogMatch ? (
            <>
              {' · matches the catalog’s '}
              <button
                type="button"
                className="rounded-sm underline decoration-border underline-offset-2 hover:text-fg focus-visible:vy-focus-ring"
                onClick={() => onUseCatalog(r.catalogMatch!.id)}
              >
                {r.catalogMatch.name}
              </button>
              {' package'}
            </>
          ) : null}
        </span>
      )
      break
    }
    default:
      return null
  }
  return (
    <div className="flex min-h-7 items-center gap-2 py-1 text-xs" role="status">
      <StatusGlyph state={glyph} size={13} />
      <span className={detection.phase === 'error' ? 'font-medium text-danger' : 'font-medium text-fg'}>{what}</span>
      {tail}
    </div>
  )
}

function ServerChecklist({ list, disabled }: { list: ImportList; disabled: boolean }) {
  return (
    <ul className="mt-2 divide-y divide-border/60 border-y border-border">
      {(list.preview ?? []).map((s) => (
        <li key={s.id} className="flex h-8 items-center gap-2 text-xs">
          <Checkbox
            checked={list.selected.has(s.id)}
            disabled={disabled}
            aria-label={`Import ${s.name}`}
            onCheckedChange={(on) => list.toggle(s.id, on)}
          />
          <span className="shrink-0 text-fg">{s.name}</span>
          <span className="min-w-0 truncate font-mono text-caption text-tertiary" title={mcpLaunchLine(s)}>
            {mcpLaunchLine(s)}
          </span>
        </li>
      ))}
    </ul>
  )
}
