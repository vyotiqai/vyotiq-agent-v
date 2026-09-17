/**
 * Standalone downloader for the embedding model files. No dictation status
 * coupling: skip-present, atomic temp-then-rename, per-file progress callback,
 * abortable via AbortSignal.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export type DownloadFileSpec = {
  relativePath: string
  url: string
  /** 404/410 on an optional file is skipped instead of failing the batch. */
  optional?: boolean
}

export function hfResolve(hubRepo: string, relativePath: string): string {
  return `https://huggingface.co/${hubRepo}/resolve/main/${relativePath}`
}

export type DownloadProgress = {
  file: string
  completed: number
  total: number
}

export async function downloadMissingFiles(
  dir: string,
  specs: DownloadFileSpec[],
  opts?: { signal?: AbortSignal; onProgress?: (p: DownloadProgress) => void }
): Promise<{ downloaded: string[]; skipped: string[] }> {
  const downloaded: string[] = []
  const skipped: string[] = []
  const total = specs.length
  for (let i = 0; i < total; i++) {
    const spec = specs[i]!
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const target = join(dir, spec.relativePath)
    if (existsSync(target)) {
      skipped.push(spec.relativePath)
      opts?.onProgress?.({ file: spec.relativePath, completed: i + 1, total })
      continue
    }
    const res = await fetch(spec.url, { redirect: 'follow', signal: opts?.signal })
    if (!res.ok) {
      if (spec.optional && (res.status === 404 || res.status === 410)) {
        skipped.push(spec.relativePath)
        opts?.onProgress?.({ file: spec.relativePath, completed: i + 1, total })
        continue
      }
      throw new Error(`Download failed (${res.status}) for ${spec.url}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (opts?.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    mkdirSync(dirname(target), { recursive: true })
    // Atomic swap so a half-written model file can never look present.
    const part = `${target}.part`
    writeFileSync(part, buf)
    renameSync(part, target)
    downloaded.push(spec.relativePath)
    opts?.onProgress?.({ file: spec.relativePath, completed: i + 1, total })
  }
  return { downloaded, skipped }
}