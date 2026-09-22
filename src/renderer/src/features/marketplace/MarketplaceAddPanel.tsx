import { useState } from 'react'
import type { DetectedMcpServer, McpDetectResult } from '@shared/ipc'
import { Button, Input, selectClass } from '@renderer/lib/ui'
import { isValidHttpUrl } from '@renderer/features/settings/utils/settingsHelpers'
import type { MarketplaceController } from './useMarketplaceController'

export function MarketplaceAddPanel({
  controller,
  onInstalled
}: {
  controller: MarketplaceController
  onInstalled: () => void
}) {
  const [pasteInput, setPasteInput] = useState('')
  const [detectResult, setDetectResult] = useState<McpDetectResult | null>(null)
  const [editServer, setEditServer] = useState<DetectedMcpServer | null>(null)
  const [serverDirty, setServerDirty] = useState(false)
  const [overwriteDup, setOverwriteDup] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [importPreview, setImportPreview] = useState<DetectedMcpServer[] | null>(null)
  const [importSelected, setImportSelected] = useState<Set<string>>(new Set())
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const [gitUrl, setGitUrl] = useState('')
  const [npmName, setNpmName] = useState('')
  const [remoteUrl, setRemoteUrl] = useState('')
  const [remoteName, setRemoteName] = useState('')
  const [remoteTransport, setRemoteTransport] = useState<'http' | 'sse'>('http')
  const [remoteBearer, setRemoteBearer] = useState('')
  const [stdioName, setStdioName] = useState('New MCP server')
  const [stdioCommand, setStdioCommand] = useState('npx')
  const [stdioArgs, setStdioArgs] = useState('-y\n@modelcontextprotocol/server-filesystem\n.')

  const {
    formLocked,
    busyTargetId,
    setFeedback,
    runInstall,
    detectMcp,
    applyDetectedMcp,
    scanExternalMcp,
    importExternalMcp
  } = controller

  const patchEditServer = (next: DetectedMcpServer): void => {
    setServerDirty(true)
    setEditServer(next)
  }

  const addStdioMcp = async (): Promise<void> => {
    const command = stdioCommand.trim() || 'npx'
    const args = stdioArgs
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const paste = [command, ...args].join(' ')
    const detected = await detectMcp(paste)
    if (detected?.server) {
      const applied = await applyDetectedMcp({
        server: {
          ...detected.server,
          name: stdioName.trim() || detected.server.name
        },
        overwrite: false
      })
      if (applied) {
        setStdioName('')
        setStdioCommand('')
        setStdioArgs('')
        onInstalled()
      }
      return
    }
    const applied = await applyDetectedMcp({
      server: {
        id: crypto.randomUUID(),
        name: stdioName.trim() || 'New MCP server',
        transport: 'stdio',
        command,
        args: args.length > 0 ? args : undefined,
        enabled: true,
        source: 'manual'
      },
      overwrite: false
    })
    if (applied) {
      setStdioName('')
      setStdioCommand('')
      setStdioArgs('')
      onInstalled()
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-2.5 py-2">
        <p className="m-0 text-xs font-medium text-fg">Add any MCP</p>
        <p className="m-0 text-caption text-secondary">
          Paste a GitHub URL, npm package, npx/uvx command, remote MCP URL, or Cursor/Claude
          mcpServers JSON. Agent V detects how to run it and connects tools to the agent.
        </p>
        <textarea
          className="min-h-[72px] w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-fg hover:border-border-strong focus-visible:border-border-strong focus-visible:vy-focus-ring disabled:vy-disabled-state disabled:hover:border-border vy-transition"
          aria-label="Paste MCP URL, command, or JSON"
          placeholder="https://github.com/…  ·  uvx mcp-server-fetch  ·  @modelcontextprotocol/server-memory"
          rows={3}
          value={pasteInput}
          disabled={formLocked}
          onChange={(e) => {
            setPasteInput(e.target.value)
            setDetectResult(null)
            setEditServer(null)
          }}
        />
        <Button
          variant="subtle"
          pending={busyTargetId === 'marketplace-detect'}
          disabled={formLocked || !pasteInput.trim()}
          onClick={() => {
            void (async () => {
              const result = await detectMcp(pasteInput.trim())
              if (!result) return
              setDetectResult(result)
              setEditServer(result.server ?? null)
              setServerDirty(false)
              setOverwriteDup(false)
            })()
          }}
        >
          Detect
        </Button>

        {detectResult ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-bg px-2 py-2">
            <p className="m-0 text-caption text-secondary">
              Kind: {detectResult.kind} · confidence: {detectResult.confidence}
              {detectResult.duplicate ? ' · already configured' : ''}
            </p>
            {detectResult.warnings.map((w) => (
              <p key={w} className="m-0 text-caption text-warning">
                {w}
              </p>
            ))}
            {detectResult.install &&
            (!editServer || (detectResult.kind === 'vyotiq-package' && !serverDirty)) ? (
              <p className="m-0 text-xs text-fg">
                Marketplace package detected — will install via marketplace.
              </p>
            ) : null}
            {editServer ? (
              <>
                <Input
                  className="w-full text-xs"
                  aria-label="Detected MCP name"
                  placeholder="Display name"
                  value={editServer.name}
                  disabled={formLocked}
                  onChange={(e) => patchEditServer({ ...editServer, name: e.target.value })}
                />
                {editServer.transport === 'http' || editServer.transport === 'sse' ? (
                  <Input
                    className="w-full font-mono text-xs"
                    aria-label="Detected MCP URL"
                    placeholder="URL"
                    value={editServer.url ?? ''}
                    disabled={formLocked}
                    onChange={(e) => patchEditServer({ ...editServer, url: e.target.value })}
                  />
                ) : (
                  <>
                    <Input
                      className="w-full font-mono text-xs"
                      aria-label="Detected MCP command"
                      placeholder="Command"
                      value={editServer.command ?? ''}
                      disabled={formLocked}
                      onChange={(e) =>
                        patchEditServer({ ...editServer, command: e.target.value })
                      }
                    />
                    <textarea
                      className="min-h-[40px] w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-fg hover:border-border-strong focus-visible:border-border-strong focus-visible:vy-focus-ring disabled:vy-disabled-state disabled:hover:border-border vy-transition"
                      aria-label="Detected MCP arguments"
                      placeholder="Arguments (one per line)"
                      rows={2}
                      value={(editServer.args ?? []).join('\n')}
                      disabled={formLocked}
                      onChange={(e) =>
                        patchEditServer({
                          ...editServer,
                          args: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean)
                        })
                      }
                    />
                  </>
                )}
              </>
            ) : null}
            {detectResult.duplicate && !(detectResult.install && !serverDirty) ? (
              <label className="flex items-center gap-2 text-caption text-secondary">
                <input
                  type="checkbox"
                  className="size-3.5 accent-fg"
                  checked={overwriteDup}
                  disabled={formLocked}
                  onChange={(e) => setOverwriteDup(e.target.checked)}
                />
                Overwrite existing server
              </label>
            ) : null}
            <Button
              variant="subtle"
              pending={busyTargetId === 'marketplace-apply'}
              disabled={
                formLocked ||
                (!editServer && !detectResult.install) ||
                (detectResult.duplicate &&
                  !overwriteDup &&
                  !(
                    detectResult.install &&
                    detectResult.kind === 'vyotiq-package' &&
                    !serverDirty
                  )) ||
                (Boolean(editServer) &&
                  !(editServer?.command ?? '').trim() &&
                  !(editServer?.url ?? '').trim() &&
                  !(
                    detectResult.install &&
                    detectResult.kind === 'vyotiq-package' &&
                    !serverDirty
                  ))
              }
              onClick={() => {
                void (async () => {
                  const preferInstall =
                    Boolean(detectResult.install) &&
                    (detectResult.kind === 'vyotiq-package' ? !serverDirty : !editServer)
                  const ok = await applyDetectedMcp(
                    preferInstall && detectResult.install
                      ? { install: detectResult.install, overwrite: false }
                      : {
                          server: editServer ?? undefined,
                          overwrite: overwriteDup
                        }
                  )
                  if (ok) {
                    setPasteInput('')
                    setDetectResult(null)
                    setEditServer(null)
                    setServerDirty(false)
                    onInstalled()
                  }
                })()
              }}
            >
              Add & connect
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-2.5 py-2">
        <p className="m-0 text-xs font-medium text-fg">Import from Cursor / Claude</p>
        <p className="m-0 text-caption text-secondary">
          Scan local mcp.json / Claude Desktop configs and import selected servers.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="subtle"
            pending={busyTargetId === 'marketplace-scan'}
            disabled={formLocked}
            onClick={() => {
              void (async () => {
                const scanned = await scanExternalMcp()
                if (!scanned) return
                setImportPreview(scanned.preview)
                setImportSelected(new Set(scanned.preview.map((s) => s.id)))
                setImportWarnings(scanned.warnings)
                if (scanned.preview.length === 0) {
                  setFeedback({
                    kind: 'error',
                    text:
                      scanned.warnings[0] ??
                      'No MCP servers found in default Cursor/Claude config paths.'
                  })
                }
              })()
            }}
          >
            Scan defaults
          </Button>
          <Button
            variant="subtle"
            pending={busyTargetId === 'marketplace-scan'}
            disabled={formLocked}
            onClick={() => {
              void (async () => {
                const pick = await window.vyotiq.marketplacePickLocal()
                if (!pick.ok) {
                  setFeedback({ kind: 'error', text: pick.error })
                  return
                }
                if (!pick.data) return
                const scanned = await scanExternalMcp([pick.data])
                if (!scanned) return
                setImportPreview(scanned.preview)
                setImportSelected(new Set(scanned.preview.map((s) => s.id)))
                setImportWarnings(scanned.warnings)
                if (scanned.preview.length === 0) {
                  setFeedback({
                    kind: 'error',
                    text: scanned.warnings[0] ?? 'No MCP servers found in that file.'
                  })
                }
              })()
            }}
          >
            Choose config file…
          </Button>
        </div>
        {importWarnings.length > 0 ? (
          <div className="flex flex-col gap-1">
            {importWarnings.map((w) => (
              <p key={w} className="m-0 text-caption text-warning">
                {w}
              </p>
            ))}
          </div>
        ) : null}
        {importPreview && importPreview.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {importPreview.map((s) => (
              <label key={s.id} className="flex items-start gap-2 text-caption text-secondary">
                <input
                  type="checkbox"
                  checked={importSelected.has(s.id)}
                  disabled={formLocked}
                  onChange={(e) => {
                    setImportSelected((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(s.id)
                      else next.delete(s.id)
                      return next
                    })
                  }}
                />
                <span>
                  <span className="text-fg">{s.name}</span>
                  {' · '}
                  {s.transport === 'stdio'
                    ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()
                    : s.url}
                </span>
              </label>
            ))}
            <Button
              variant="subtle"
              pending={busyTargetId === 'marketplace-import'}
              disabled={formLocked || importSelected.size === 0}
              onClick={() => {
                void (async () => {
                  const selected = importPreview.filter((s) => importSelected.has(s.id))
                  const ok = await importExternalMcp({
                    mode: 'merge',
                    selectedIds: [...importSelected],
                    servers: selected
                  })
                  if (ok) {
                    setImportPreview(null)
                    setImportSelected(new Set())
                    setImportWarnings([])
                    onInstalled()
                  }
                })()
              }}
            >
              Import selected
            </Button>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className="m-0 self-start text-xs text-secondary underline-offset-2 hover:text-fg hover:underline"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? 'Hide advanced' : 'Show advanced'}
      </button>

      {showAdvanced ? (
        <>
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-2.5 py-2">
            <p className="m-0 text-xs font-medium text-fg">Stdio MCP</p>
            <p className="m-0 text-caption text-secondary">
              Run a local MCP server via command (e.g. npx). Added enabled by default.
            </p>
            <Input
              className="w-full text-xs"
              aria-label="Stdio MCP display name"
              placeholder="Display name"
              value={stdioName}
              disabled={formLocked}
              onChange={(e) => setStdioName(e.target.value)}
            />
            <Input
              className="w-full font-mono text-xs"
              aria-label="Stdio MCP command"
              placeholder="Command (e.g. npx)"
              value={stdioCommand}
              disabled={formLocked}
              onChange={(e) => setStdioCommand(e.target.value)}
            />
            <textarea
              className="min-h-[52px] w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg"
              aria-label="Stdio MCP arguments"
              placeholder="Arguments (one per line)"
              rows={3}
              value={stdioArgs}
              disabled={formLocked}
              onChange={(e) => setStdioArgs(e.target.value)}
            />
            <Button
              variant="subtle"
              pending={
                busyTargetId === 'marketplace-detect' || busyTargetId === 'marketplace-apply'
              }
              disabled={formLocked || !stdioCommand.trim()}
              onClick={() => void addStdioMcp()}
            >
              Add stdio MCP
            </Button>
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-2.5 py-2">
            <p className="m-0 text-xs font-medium text-fg">Remote MCP (HTTP / SSE)</p>
            <p className="m-0 text-caption text-secondary">
              Paste a streamable HTTP or SSE MCP endpoint. Auth (Bearer / OAuth) under Installed.
            </p>
            <Input
              className="w-full font-mono text-xs"
              aria-label="Remote MCP URL"
              placeholder="https://mcp.example.com/mcp"
              value={remoteUrl}
              disabled={formLocked}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <Input
              className="w-full text-xs"
              aria-label="Remote MCP display name"
              placeholder="Display name (optional)"
              value={remoteName}
              disabled={formLocked}
              onChange={(e) => setRemoteName(e.target.value)}
            />
            <select
              className={selectClass}
              aria-label="Remote MCP transport"
              value={remoteTransport}
              disabled={formLocked}
              onChange={(e) => setRemoteTransport(e.target.value as 'http' | 'sse')}
            >
              <option value="http">http (streamable)</option>
              <option value="sse">sse</option>
            </select>
            <Input
              className="w-full font-mono text-xs"
              type="password"
              autoComplete="off"
              aria-label="Remote MCP Bearer token"
              placeholder="Bearer token (optional, OS secure storage)"
              value={remoteBearer}
              disabled={formLocked}
              onChange={(e) => setRemoteBearer(e.target.value)}
            />
            <Button
              variant="subtle"
              pending={busyTargetId === 'marketplace-install-remote'}
              disabled={formLocked || !remoteUrl.trim()}
              onClick={() => {
                void (async () => {
                  if (!isValidHttpUrl(remoteUrl.trim())) {
                    setFeedback({
                      kind: 'error',
                      text: 'Enter a valid http(s) MCP URL.'
                    })
                    return
                  }
                  const ok = await runInstall(
                    {
                      source: 'remote',
                      target: remoteUrl.trim(),
                      kind: 'mcp',
                      name: remoteName.trim() || undefined,
                      transport: remoteTransport,
                      bearerToken: remoteBearer.trim() || undefined
                    },
                    { busyTargetId: 'marketplace-install-remote' }
                  )
                  if (ok) {
                    setRemoteUrl('')
                    setRemoteName('')
                    setRemoteBearer('')
                    onInstalled()
                  }
                })()
              }}
            >
              Install remote MCP
            </Button>
          </div>

          <p className="m-0 text-xs font-medium text-fg">Local / package sources</p>
          <Button
            variant="subtle"
            pending={busyTargetId === 'marketplace-install-path'}
            disabled={formLocked}
            onClick={() => {
              void (async () => {
                const pick = await window.vyotiq.marketplacePickLocal()
                if (!pick.ok) {
                  setFeedback({ kind: 'error', text: pick.error })
                  return
                }
                if (!pick.data) return
                const path = pick.data
                const isZip = /\.(zip|tgz)$/i.test(path)
                const ok = await runInstall(
                  { source: isZip ? 'zip' : 'path', target: path },
                  { busyTargetId: 'marketplace-install-path' }
                )
                if (ok) onInstalled()
              })()
            }}
          >
            Choose folder or zip…
          </Button>
          <div className="flex gap-2">
            <Input
              className="flex-1 font-mono text-xs"
              aria-label="Git clone URL"
              placeholder="git clone URL"
              value={gitUrl}
              disabled={formLocked}
              onChange={(e) => setGitUrl(e.target.value)}
            />
            <Button
              variant="subtle"
              pending={busyTargetId === 'marketplace-install-git'}
              disabled={formLocked || !gitUrl.trim()}
              onClick={() => {
                void (async () => {
                  const ok = await runInstall(
                    { source: 'git', target: gitUrl.trim() },
                    { busyTargetId: 'marketplace-install-git' }
                  )
                  if (ok) {
                    setGitUrl('')
                    onInstalled()
                  }
                })()
              }}
            >
              Install git
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              className="flex-1 font-mono text-xs"
              aria-label="npm package name"
              placeholder="npm package name"
              value={npmName}
              disabled={formLocked}
              onChange={(e) => setNpmName(e.target.value)}
            />
            <Button
              variant="subtle"
              pending={busyTargetId === 'marketplace-install-npm'}
              disabled={formLocked || !npmName.trim()}
              onClick={() => {
                void (async () => {
                  const ok = await runInstall(
                    { source: 'npm', target: npmName.trim() },
                    { busyTargetId: 'marketplace-install-npm' }
                  )
                  if (ok) {
                    setNpmName('')
                    onInstalled()
                  }
                })()
              }}
            >
              Install npm
            </Button>
          </div>
        </>
      ) : null}
    </div>
  )
}
