import { existsSync, statSync } from 'fs'
import { dirname, extname, join, relative } from 'path'
import { execFile as execFileCallback } from 'child_process'
import spawn from 'cross-spawn'
import { promisify } from 'util'
import { fileURLToPath, pathToFileURL } from 'url'
import type {
  WorkspaceLspCapability,
  WorkspaceLspRequest,
  WorkspaceLspResponse,
  WorkspaceLspServer,
  WorkspaceLspStatus
} from '../../shared/ipc'
import {
  canonicalizeWorkspacePath,
  isSafeWorkspaceRelPath
} from '../../shared/utils/workspacePath'

const execFile = promisify(execFileCallback)
const LSP_PROBE_TIMEOUT_MS = 2_000
const LSP_REQUEST_TIMEOUT_MS = 5_000
const LSP_MAX_PENDING_REQUESTS = 32
const LSP_MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const LSP_IDLE_TIMEOUT_MS = 5 * 60_000
const LSP_DIAGNOSTICS_WAIT_MS = 750

type LspCandidate = {
  id: string
  label: string
  command: string
  args: string[]
  extensions: string[]
  languageId: string
}

type DetectedLspServer = LspCandidate & {
  executable: string
  source: WorkspaceLspServer['source']
}

const CANDIDATES: LspCandidate[] = [
  {
    id: 'typescript',
    label: 'TypeScript Language Server',
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    languageId: 'typescript'
  },
  {
    id: 'pyright',
    label: 'Pyright',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    languageId: 'python'
  },
  {
    id: 'pylsp',
    label: 'Python LSP Server',
    command: 'pylsp',
    args: [],
    extensions: ['.py', '.pyi'],
    languageId: 'python'
  },
  {
    id: 'rust-analyzer',
    label: 'rust-analyzer',
    command: 'rust-analyzer',
    args: [],
    extensions: ['.rs'],
    languageId: 'rust'
  },
  {
    id: 'gopls',
    label: 'gopls',
    command: 'gopls',
    args: ['serve', '-listen=stdio'],
    extensions: ['.go'],
    languageId: 'go'
  },
  {
    id: 'clangd',
    label: 'clangd',
    command: 'clangd',
    args: ['--log=error'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'],
    languageId: 'cpp'
  }
]

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * True when `path` resolves to a real tsserver.js file (the marker of a usable
 * TS language-service SDK). TypeScript 7 workspaces ship `tsc.js` only, so this
 * is what distinguishes a usable SDK from a workspace typescript install.
 */
function isTsserverSdkFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Workspace SDK at `{workspace}/node_modules/typescript/lib/tsserver.js`, if usable. */
export function workspaceTsserverSdkPath(workspacePath: string): string | null {
  const candidate = join(workspacePath, 'node_modules', 'typescript', 'lib', 'tsserver.js')
  return isTsserverSdkFile(candidate) ? candidate : null
}

/**
 * Global npm TypeScript SDK for the typescript-language-server fallback:
 * sibling `node_modules` next to the tls executable first (global npm layout),
 * then the npm appdata root (`%APPDATA%\npm`). Injectable root keeps tests
 * hermetic; pass `appdataNpmRoot` only from tests.
 */
export function globalTsserverSdkPath(
  tlsExecutable: string | null,
  appdataNpmRoot?: string
): string | null {
  const candidates: string[] = []
  if (tlsExecutable) {
    candidates.push(
      join(dirname(tlsExecutable), 'node_modules', 'typescript', 'lib', 'tsserver.js')
    )
  }
  const appdata = appdataNpmRoot ?? (process.platform === 'win32' ? process.env.APPDATA : undefined)
  if (appdata) {
    candidates.push(join(appdata, 'npm', 'node_modules', 'typescript', 'lib', 'tsserver.js'))
  }
  return candidates.find((candidate) => isTsserverSdkFile(candidate)) ?? null
}

/**
 * initializationOptions for typescript-language-server. Set ONLY when the
 * workspace TypeScript lacks a usable tsserver.js (TypeScript 7 ships tsc only)
 * and a global SDK exists — tls then skips its broken workspace probe and uses
 * the global language-service SDK. Never set when the workspace SDK is valid:
 * tls gives `tsserver.path` precedence over the workspace.
 */
export function tsserverInitOptionsFromPaths(
  workspaceTsserverPath: string | null,
  globalTsserverPath: string | null
): Record<string, unknown> | undefined {
  if (workspaceTsserverPath) return undefined
  if (!globalTsserverPath) return undefined
  return { tsserver: { path: globalTsserverPath } }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function localExecutable(workspacePath: string, command: string): string | null {
  const bin = join(workspacePath, 'node_modules', '.bin')
  const names =
    process.platform === 'win32' ? [`${command}.cmd`, `${command}.exe`, command] : [command]
  for (const name of names) {
    const candidate = join(bin, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

async function pathExecutable(command: string): Promise<string | null> {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const { stdout } = await execFile(lookup, [command], {
      encoding: 'utf8',
      timeout: LSP_PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    return (
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    )
  } catch {
    return null
  }
}

async function detectServer(
  workspacePath: string,
  path: string
): Promise<DetectedLspServer | null> {
  if (!isSafeWorkspaceRelPath(path)) return null
  const extension = extname(path).toLowerCase()
  const candidates = CANDIDATES.filter((candidate) => candidate.extensions.includes(extension))
  for (const candidate of candidates) {
    const local = localExecutable(workspacePath, candidate.command)
    if (local) return { ...candidate, executable: local, source: 'workspace' }
    const onPath = await pathExecutable(candidate.command)
    if (onPath) return { ...candidate, executable: onPath, source: 'path' }
  }
  return null
}

type RpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: unknown }
}

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type StoredDiagnostic = {
  line: number
  character: number
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
}

function lspUri(workspacePath: string, path: string): string {
  return pathToFileURL(join(workspacePath, ...path.split('/'))).toString()
}

/**
 * Canonical comparison form for LSP document URIs. Servers normalize Windows
 * URIs differently than Node's pathToFileURL: e.g. tls 6.0.0 publishes
 * `file:///c%3A/Users/...` (lowercase drive, percent-encoded colon) where we
 * sent `file:///C:/Users/...`. Diagnostics keyed by the raw wire form never
 * match our lookups, so both sides are canonicalized at every map boundary.
 */
function canonicalLspUri(uri: string): string {
  let out = uri
  try {
    out = decodeURIComponent(out)
  } catch {
    // Malformed escapes: fall back to the raw form.
  }
  // Lowercase a lone drive letter after file:/// (Windows only shape).
  return out.replace(/^(file:\/\/\/)([A-Za-z])([:|])/, (_m, scheme, drive, sep) => `${scheme}${drive.toLowerCase()}:`)
}

function severity(value: unknown): StoredDiagnostic['severity'] {
  switch (value) {
    case 1:
      return 'error'
    case 2:
      return 'warning'
    case 3:
      return 'info'
    case 4:
      return 'hint'
    default:
      return 'info'
  }
}

function parseDiagnostics(value: unknown): StoredDiagnostic[] {
  const root = record(value)
  const rawDiagnostics = root?.diagnostics
  if (!Array.isArray(rawDiagnostics)) return []
  const output: StoredDiagnostic[] = []
  for (const raw of rawDiagnostics.slice(0, 1_000)) {
    const item = record(raw)
    const range = record(item?.range)
    const start = record(range?.start)
    const message = stringValue(item?.message)
    if (!start || !message) continue
    const line = typeof start.line === 'number' ? Math.max(0, Math.floor(start.line)) : 0
    const character =
      typeof start.character === 'number' ? Math.max(0, Math.floor(start.character)) : 0
    output.push({
      line,
      character,
      message: message.slice(0, 4_096),
      severity: severity(item?.severity)
    })
  }
  return output
}

function parseCapabilities(value: unknown): Set<WorkspaceLspCapability> {
  const capabilities = record(record(value)?.capabilities)
  const output = new Set<WorkspaceLspCapability>()
  if (capabilities?.hoverProvider) output.add('hover')
  if (capabilities?.completionProvider) output.add('completion')
  if (capabilities?.diagnosticProvider) output.add('diagnostics')
  if (capabilities?.definitionProvider) output.add('definition')
  if (capabilities?.renameProvider) output.add('rename')
  return output
}

function markupText(value: unknown): string | null {
  const text = stringValue(value)
  if (text) return text
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        const object = record(item)
        return stringValue(object?.value) ?? stringValue(item)
      })
      .filter((item): item is string => item != null)
    return parts.length > 0 ? parts.join('\n') : null
  }
  const object = record(value)
  return stringValue(object?.value)
}

function fileUriToWorkspaceRel(uri: string | null | undefined, workspacePath: string): string | null {
  if (!uri?.startsWith('file:')) return null
  try {
    const rel = relative(workspacePath, fileURLToPath(uri))
    if (!rel || rel.startsWith('..') || rel.startsWith('/') || rel.startsWith('\\')) return null
    return rel.split('\\').join('/')
  } catch {
    return null
  }
}

function parseWorkspaceEdits(
  value: unknown,
  workspacePath: string
): Array<{
  path: string
  startLine: number
  startCharacter: number
  endLine: number
  endCharacter: number
  newText: string
}> {
  const edits: Array<{
    path: string
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
    newText: string
  }> = []
  const changes = record(record(value)?.changes)
  if (!changes) return edits
  for (const [uri, list] of Object.entries(changes)) {
    const path = fileUriToWorkspaceRel(uri, workspacePath)
    if (!path || !Array.isArray(list)) continue
    for (const item of list) {
      const object = record(item)
      const range = record(object?.range)
      const start = record(range?.start)
      const end = record(range?.end)
      edits.push({
        path,
        startLine: typeof start?.line === 'number' ? start.line : 0,
        startCharacter: typeof start?.character === 'number' ? start.character : 0,
        endLine: typeof end?.line === 'number' ? end.line : 0,
        endCharacter: typeof end?.character === 'number' ? end.character : 0,
        newText: stringValue(object?.newText) ?? ''
      })
      if (edits.length >= 200) return edits
    }
  }
  return edits
}

class LspClient {
  readonly capabilities = new Set<WorkspaceLspCapability>()
  readonly diagnostics = new Map<string, StoredDiagnostic[]>()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly opened = new Map<string, { version: number; content: string }>()
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private child: ReturnType<typeof spawn> | null = null
  private disposed = false
  private initialized = false
  private startPromise: Promise<void> | null = null
  private failure: Error | null = null
  private readonly diagnosticWaiters = new Map<
    string,
    Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>
  >()
  lastUsed = Date.now()

  constructor(
    private readonly workspacePath: string,
    private readonly server: DetectedLspServer
  ) {}

  get serverInfo(): WorkspaceLspServer {
    return {
      id: this.server.id,
      label: this.server.label,
      command: this.server.executable,
      source: this.server.source,
      capabilities: [...this.capabilities]
    }
  }

  async start(): Promise<void> {
    if (this.failure) throw this.failure
    if (this.initialized) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async startInternal(): Promise<void> {
    if (this.disposed) throw new Error('LSP server is no longer available')
    const child = spawn(this.server.executable, this.server.args, {
      cwd: this.workspacePath,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk))
    child.stderr?.on('data', () => undefined)
    child.once('error', (error) => this.fail(error))
    child.once('exit', () => this.fail(new Error('LSP server exited')))
    const initializationOptions =
      this.server.id === 'typescript'
        ? tsserverInitOptionsFromPaths(
            workspaceTsserverSdkPath(this.workspacePath),
            globalTsserverSdkPath(this.server.executable)
          )
        : undefined
    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.workspacePath).toString(),
      rootPath: this.workspacePath,
      ...(initializationOptions ? { initializationOptions } : {}),
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: false } },
          publishDiagnostics: {}
        }
      },
      workspaceFolders: [
        {
          uri: pathToFileURL(this.workspacePath).toString(),
          name: this.workspacePath.split(/[\\/]/).pop() || 'workspace'
        }
      ]
    })
    this.capabilities.clear()
    for (const capability of parseCapabilities(result)) this.capabilities.add(capability)
    this.initialized = true
    this.notify('initialized', {})
  }

  private consume(chunk: Buffer): void {
    if (this.disposed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > LSP_MAX_MESSAGE_BYTES * 2) {
      this.fail(new Error('LSP output exceeded the bounded message limit'))
      return
    }
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const lengthMatch = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header)
      if (!lengthMatch) {
        this.fail(new Error('LSP response omitted Content-Length'))
        return
      }
      const length = Number(lengthMatch[1])
      if (!Number.isSafeInteger(length) || length < 0 || length > LSP_MAX_MESSAGE_BYTES) {
        this.fail(new Error('LSP response exceeded the bounded message limit'))
        return
      }
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + length)
      let message: RpcMessage
      try {
        message = JSON.parse(body) as RpcMessage
      } catch {
        this.fail(new Error('LSP returned invalid JSON'))
        return
      }
      this.handleMessage(message)
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = record(message.params)
      const uri = stringValue(params?.uri)
      if (uri) {
        this.capabilities.add('diagnostics')
        this.diagnostics.set(canonicalLspUri(uri), parseDiagnostics(message.params))
        const key = canonicalLspUri(uri)
        const waiters = this.diagnosticWaiters.get(key)
        if (waiters) {
          this.diagnosticWaiters.delete(key)
          for (const waiter of waiters) {
            clearTimeout(waiter.timer)
            waiter.resolve()
          }
        }
      }
    }
    if (message.id == null) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) {
      pending.reject(new Error(stringValue(message.error.message) ?? 'LSP request failed'))
    } else {
      pending.resolve(message.result)
    }
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    this.initialized = false
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.resolve()
      }
    }
    this.diagnosticWaiters.clear()
    try {
      this.child?.kill()
    } catch {
      // The process may already have exited.
    }
    this.child = null
  }

  private send(message: RpcMessage): void {
    if (!this.child?.stdin || this.disposed) throw new Error('LSP server is unavailable')
    const body = JSON.stringify(message)
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
    this.child.stdin.write(header + body)
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.lastUsed = Date.now()
    if (this.pending.size >= LSP_MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Too many pending LSP requests'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, LSP_REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async open(path: string, content: string): Promise<string> {
    await this.start()
    const uri = canonicalLspUri(lspUri(this.workspacePath, path))
    const existing = this.opened.get(uri)
    if (!existing) {
      this.opened.set(uri, { version: 1, content })
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.server.languageId, version: 1, text: content }
      })
    } else if (existing.content !== content) {
      const version = existing.version + 1
      this.opened.set(uri, { version, content })
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      })
    }
    this.lastUsed = Date.now()
    return uri
  }

  private waitForDiagnostics(uri: string): Promise<void> {
    if (this.diagnostics.has(uri)) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A publish may have landed between the last waiter check and this timer.
        if (this.diagnostics.has(uri)) {
          resolve()
          return
        }
        const waiters = this.diagnosticWaiters.get(uri)
        if (waiters) {
          this.diagnosticWaiters.set(
            uri,
            waiters.filter((waiter) => waiter.timer !== timer)
          )
        }
        resolve()
      }, LSP_DIAGNOSTICS_WAIT_MS)
      const waiters = this.diagnosticWaiters.get(uri) ?? []
      waiters.push({ resolve, timer })
      this.diagnosticWaiters.set(uri, waiters)
    })
  }

  async execute(request: WorkspaceLspRequest): Promise<WorkspaceLspResponse> {
    const uri = await this.open(request.path, request.content)
    if (
      request.action !== 'diagnostics' &&
      !this.capabilities.has(request.action)
    ) {
      throw new Error(`Detected ${this.server.label} does not provide ${request.action}`)
    }
    if (request.action === 'diagnostics') {
      await this.waitForDiagnostics(uri)
      return { kind: 'diagnostics', items: this.diagnostics.get(uri) ?? [] }
    }
    const params = {
      textDocument: { uri },
      position: { line: request.line, character: request.character }
    }
    if (request.action === 'definition') {
      const result = await this.request('textDocument/definition', params)
      const first = Array.isArray(result) ? result[0] : result
      const object = record(first)
      const targetUri = stringValue(object?.uri) ?? stringValue(object?.targetUri)
      const range = record(object?.range) ?? record(object?.targetSelectionRange) ?? record(object?.targetRange)
      const start = record(range?.start)
      return {
        kind: 'definition',
        path: fileUriToWorkspaceRel(targetUri, request.workspacePath),
        line: typeof start?.line === 'number' ? start.line : 0,
        character: typeof start?.character === 'number' ? start.character : 0
      }
    }
    if (request.action === 'rename') {
      const newName = request.newName?.trim()
      if (!newName) throw new Error('Rename requires a new name')
      const result = await this.request('textDocument/rename', { ...params, newName })
      return { kind: 'rename', edits: parseWorkspaceEdits(result, request.workspacePath) }
    }
    const result = await this.request(
      request.action === 'hover' ? 'textDocument/hover' : 'textDocument/completion',
      params
    )
    if (request.action === 'hover') {
      const content = markupText(record(result)?.contents)
      return { kind: 'hover', content: content?.slice(0, 16_384) ?? null }
    }
    const root = record(result)
    const rawItems = Array.isArray(result) ? result : root?.items
    const items = Array.isArray(rawItems)
      ? rawItems
          .slice(0, 200)
          .map((item) => {
            const object = record(item)
            return {
              label: stringValue(object?.label) ?? '',
              detail: stringValue(object?.detail)
            }
          })
          .filter((item) => item.label.length > 0)
      : []
    return { kind: 'completion', items }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fail(new Error('LSP server disposed'))
    try {
      this.child?.kill()
    } catch {
      // The process may already have exited.
    }
    this.child = null
  }
}

const clients = new Map<string, LspClient>()

function clientKey(workspacePath: string, server: DetectedLspServer): string {
  return `${canonicalizeWorkspacePath(workspacePath).toLowerCase()}\0${server.id}\0${server.executable.toLowerCase()}`
}

async function getClient(
  workspacePath: string,
  path: string
): Promise<{ client: LspClient; server: DetectedLspServer }> {
  const server = await detectServer(workspacePath, path)
  if (!server) {
    throw new Error(`No installed language server supports ${extname(path) || 'this file'}`)
  }
  const key = clientKey(workspacePath, server)
  let client = clients.get(key)
  if (!client) {
    client = new LspClient(workspacePath, server)
    clients.set(key, client)
  }
  client.lastUsed = Date.now()
  return { client, server }
}

export async function workspaceLspStatus(
  workspacePath: string,
  path: string
): Promise<WorkspaceLspStatus> {
  const server = await detectServer(workspacePath, path)
  if (!server) {
    return {
      kind: 'unavailable',
      detail: `No installed language server supports ${extname(path) || 'this file'}.`
    }
  }
  const client = clients.get(clientKey(workspacePath, server))
  return {
    kind: 'available',
    server: {
      id: server.id,
      label: server.label,
      command: server.executable,
      source: server.source,
      capabilities: client ? [...client.capabilities] : []
    }
  }
}

export async function workspaceLspRequest(
  request: WorkspaceLspRequest
): Promise<WorkspaceLspResponse> {
  const { client, server } = await getClient(request.workspacePath, request.path)
  try {
    return await client.execute(request)
  } catch (error) {
    const key = clientKey(request.workspacePath, server)
    if (clients.get(key) === client) {
      client.dispose()
      clients.delete(key)
    }
    throw error
  }
}

function cleanupIdleClients(): void {
  const now = Date.now()
  for (const [key, client] of clients) {
    if (now - client.lastUsed > LSP_IDLE_TIMEOUT_MS) {
      client.dispose()
      clients.delete(key)
    }
  }
}

const cleanupTimer = setInterval(cleanupIdleClients, 60_000)
cleanupTimer.unref?.()

export function disposeWorkspaceLsp(workspacePath: string): void {
  const prefix = `${canonicalizeWorkspacePath(workspacePath).toLowerCase()}\0`
  for (const [key, client] of clients) {
    if (!key.startsWith(prefix)) continue
    client.dispose()
    clients.delete(key)
  }
}
