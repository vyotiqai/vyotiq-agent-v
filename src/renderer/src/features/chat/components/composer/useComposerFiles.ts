import { useCallback, useState } from 'react'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_NATIVE_FILE_BYTES,
  type AttachedFile,
  type AttachedNativeFile
} from '@shared/ipc'
import {
  getComposerAttachments,
  setComposerAttachments,
  useComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'

export const MAX_FILES = 5

/** Everything the picker offers beyond images; main decides what it can parse. */
export const ATTACHMENT_ACCEPT =
  'image/*,.pdf,.txt,.md,.mdx,.markdown,.json,.jsonc,.yaml,.yml,.toml,.ini,.csv,.tsv,.log,.sql,.html,.xml,.css,.scss,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cc,.cpp,.hpp,.cs,.php,.sh,.bash,.ps1,.patch,.diff,text/*,audio/wav,audio/mpeg,audio/mp3,.wav,.mp3,.m4a'

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/**
 * Non-image attachments.
 *
 * When `preferNativePdf` is true (model advertises `file`), PDFs are kept as
 * base64 `file_native` parts; otherwise main extracts text as today.
 */
export function useComposerFiles(opts?: {
  preferNativePdf?: boolean
  getPreferNativePdf?: () => boolean
  /** Workspace key — attachments survive Composer remounts when set. */
  persistKey?: string | null
}) {
  const preferNativePdf = (): boolean =>
    opts?.getPreferNativePdf?.() ?? opts?.preferNativePdf === true
  const persistKey = opts?.persistKey ?? null
  const persisted = useComposerAttachments(persistKey)
  const [localFiles, setLocalFiles] = useState<AttachedFile[]>([])
  const [localNativeFiles, setLocalNativeFiles] = useState<AttachedNativeFile[]>([])
  const [fileError, setFileError] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)

  const files = persistKey ? persisted.files : localFiles
  const nativeFiles = persistKey ? persisted.nativeFiles : localNativeFiles
  const setFiles = useCallback(
    (next: AttachedFile[] | ((prev: AttachedFile[]) => AttachedFile[])): void => {
      if (persistKey) {
        const value = typeof next === 'function' ? next(getComposerAttachments(persistKey).files) : next
        setComposerAttachments(persistKey, { files: value })
      } else {
        setLocalFiles(next)
      }
    },
    [persistKey]
  )
  const setNativeFiles = useCallback(
    (next: AttachedNativeFile[] | ((prev: AttachedNativeFile[]) => AttachedNativeFile[])): void => {
      if (persistKey) {
        const value =
          typeof next === 'function' ? next(getComposerAttachments(persistKey).nativeFiles) : next
        setComposerAttachments(persistKey, { nativeFiles: value })
      } else {
        setLocalNativeFiles(next)
      }
    },
    [persistKey]
  )

  const totalCount = files.length + nativeFiles.length

  const addFiles = async (picked: File[]): Promise<void> => {
    if (!picked.length) return
    const room = MAX_FILES - totalCount
    if (room <= 0) {
      setFileError(`You can attach up to ${MAX_FILES} files.`)
      return
    }

    const useNative = preferNativePdf()
    const problems: string[] = []
    const accepted: AttachedFile[] = []
    const acceptedNative: AttachedNativeFile[] = []
    setExtracting(true)
    try {
      for (const file of picked.slice(0, room)) {
        const maxBytes = useNative && isPdfFile(file) ? MAX_NATIVE_FILE_BYTES : MAX_ATTACHMENT_BYTES
        if (file.size > maxBytes) {
          problems.push(`${file.name} is over ${Math.round(maxBytes / (1024 * 1024))}MB`)
          continue
        }
        try {
          const data = await readAsBase64(file)
          if (useNative && isPdfFile(file)) {
            acceptedNative.push({
              type: 'file_native',
              name: file.name,
              mime: file.type || 'application/pdf',
              data
            })
            continue
          }
          const res = await window.vyotiq.extractAttachment({
            name: file.name,
            mime: file.type || '',
            data
          })
          if (!res.ok) {
            problems.push(res.error)
            continue
          }
          accepted.push({
            type: 'file',
            name: res.data.name,
            mime: res.data.mime,
            text: res.data.text
          })
          if (res.data.truncated) problems.push(`${res.data.name} was truncated`)
        } catch {
          problems.push(`Could not read ${file.name}`)
        }
      }
    } finally {
      setExtracting(false)
    }

    if (picked.length > room) problems.push(`Only ${MAX_FILES} files allowed`)
    setFileError(problems.length ? problems.join(' · ') : null)
    if (accepted.length) setFiles((prev) => [...prev, ...accepted].slice(0, MAX_FILES))
    if (acceptedNative.length) {
      setNativeFiles((prev) => [...prev, ...acceptedNative].slice(0, MAX_FILES))
    }
  }

  const removeFile = (index: number): void => {
    setFiles((prev) => prev.filter((_, j) => j !== index))
    setFileError(null)
  }

  const removeNativeFile = (index: number): void => {
    setNativeFiles((prev) => prev.filter((_, j) => j !== index))
    setFileError(null)
  }

  const clearFiles = (): void => {
    setFiles([])
    setNativeFiles([])
    setFileError(null)
  }

  return {
    files,
    setFiles,
    nativeFiles,
    setNativeFiles,
    fileError,
    setFileError,
    extracting,
    addFiles,
    removeFile,
    removeNativeFile,
    clearFiles
  }
}
