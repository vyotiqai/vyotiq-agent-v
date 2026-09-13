import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'
import { setDictationRuntimeStatus } from './modelStatus'

const DOWNLOAD_STATUS_THROTTLE_MS = 75
let lastDownloadStatusAt = 0

function publishDownloadStatus(partial: Parameters<typeof setDictationRuntimeStatus>[0]): void {
  const now = Date.now()
  const force =
    partial.phase === 'error' ||
    partial.phase === 'ready' ||
    (typeof partial.progress === 'number' && partial.progress >= 0.99)
  if (!force && now - lastDownloadStatusAt < DOWNLOAD_STATUS_THROTTLE_MS) return
  lastDownloadStatusAt = now
  setDictationRuntimeStatus(partial)
}

export type DownloadFileSpec = {
  relativePath: string
  url: string
  optional?: boolean
}

export function hfResolve(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}`
}

export function modelFilesPresent(modelDir: string, files: DownloadFileSpec[]): boolean {
  return files
    .filter((f) => !f.optional)
    .every((f) => {
      const p = join(modelDir, f.relativePath)
      if (!existsSync(p)) return false
      try {
        return statSync(p).size > 0
      } catch {
        return false
      }
    })
}

/** Resolve dest under modelDir; reject path traversal. */
export function resolveModelFilePath(modelDir: string, relativePath: string): string {
  const root = resolve(modelDir)
  const dest = resolve(root, relativePath)
  const prefix = root.endsWith(sep) ? root : root + sep
  if (dest !== root && !dest.startsWith(prefix)) {
    throw new Error(`Refusing path outside model dir: ${relativePath}`)
  }
  return dest
}

async function downloadOne(
  url: string,
  dest: string,
  onChunk: (received: number, total: number | null) => void,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  try {
    if (existsSync(partial)) unlinkSync(partial)
  } catch {
    /* ignore */
  }
  const res = await fetchImpl(url, { signal, redirect: 'follow' })
  if (!res.ok) {
    throw new Error(`Download failed HTTP ${res.status} for ${url}`)
  }
  const totalHeader = res.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : null
  if (!res.body) throw new Error(`Download missing body for ${url}`)
  const nodeStream = Readable.fromWeb(res.body as import('stream/web').ReadableStream)
  let received = 0
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length
    onChunk(received, total && Number.isFinite(total) ? total : null)
  })
  await pipeline(nodeStream, createWriteStream(partial))
  renameSync(partial, dest)
}

/**
 * Download Whisper artifacts into `modelDir`. Skips files that already exist.
 * Optional files may 404 without failing the install.
 */
export async function downloadDictationModelFiles(
  modelDir: string,
  files: DownloadFileSpec[],
  opts: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    activeModelId?: import('../../shared/ipc').DictationLocalModelId
  } = {}
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch
  mkdirSync(modelDir, { recursive: true })
  if (modelFilesPresent(modelDir, files)) return true

  const missing = files.filter((f) => {
    try {
      return !existsSync(resolveModelFilePath(modelDir, f.relativePath))
    } catch {
      return true
    }
  })
  const requiredCount = files.filter((f) => !f.optional).length
  let completedRequired = files.filter((f) => !f.optional).length - missing.filter((f) => !f.optional).length

  for (const spec of missing) {
    let dest: string
    try {
      dest = resolveModelFilePath(modelDir, spec.relativePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (spec.optional) continue
      setDictationRuntimeStatus({
        phase: 'error',
        error: msg,
        message: `Failed: ${spec.relativePath}`,
        activeModelId: opts.activeModelId ?? null
      })
      return false
    }
    try {
      await downloadOne(
        spec.url,
        dest,
        (received, total) => {
          const fileFrac = total && total > 0 ? received / total : 0
          const denom = Math.max(1, requiredCount)
          const progress = Math.min(0.99, (completedRequired + (spec.optional ? 0 : fileFrac)) / denom)
          publishDownloadStatus({
            phase: 'downloading',
            progress,
            error: null,
            message: `Downloading ${spec.relativePath}`,
            activeModelId: opts.activeModelId ?? null
          })
        },
        fetchImpl,
        opts.signal
      )
      if (!spec.optional) completedRequired++
    } catch (err) {
      try {
        if (existsSync(`${dest}.partial`)) unlinkSync(`${dest}.partial`)
      } catch {
        /* ignore */
      }
      if (spec.optional) continue
      const msg = err instanceof Error ? err.message : String(err)
      setDictationRuntimeStatus({
        phase: 'error',
        error: msg,
        message: `Failed: ${spec.relativePath}`,
        activeModelId: opts.activeModelId ?? null
      })
      return false
    }
  }
  return modelFilesPresent(modelDir, files)
}
