import { useCallback, useState } from 'react'
import { MAX_IMAGE_BYTES } from '@shared/ipc'
import {
  getComposerAttachments,
  setComposerAttachments,
  useComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'

export const MAX_IMAGES = 4

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/** Attachments persist across Composer remounts when persistKey (workspace) is set. */
export function useComposerImages(persistKey?: string | null) {
  const persisted = useComposerAttachments(persistKey)
  const [localImages, setLocalImages] = useState<string[]>([])
  const [imageError, setImageError] = useState<string | null>(null)

  const images = persistKey ? persisted.images : localImages
  const setImages = useCallback(
    (next: string[] | ((prev: string[]) => string[])): void => {
      if (persistKey) {
        const value = typeof next === 'function' ? next(getComposerAttachments(persistKey).images) : next
        setComposerAttachments(persistKey, { images: value })
      } else {
        setLocalImages(next)
      }
    },
    [persistKey]
  )

  const onPickImages = async (files: FileList | File[] | null): Promise<void> => {
    if (!files?.length) return
    const room = MAX_IMAGES - images.length
    if (room <= 0) {
      setImageError(`You can attach up to ${MAX_IMAGES} images.`)
      return
    }

    const next: string[] = []
    let skippedSize = 0
    let skippedRead = 0
    let skippedCap = 0
    let considered = 0

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      considered += 1
      if (next.length >= room) {
        skippedCap += 1
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        skippedSize += 1
        continue
      }
      try {
        next.push(await readFileAsDataUrl(file))
      } catch {
        skippedRead += 1
      }
    }

    const parts: string[] = []
    if (skippedSize > 0) {
      parts.push(
        `Skipped ${skippedSize} image${skippedSize > 1 ? 's' : ''} over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB`
      )
    }
    if (skippedRead > 0) {
      parts.push(`Could not read ${skippedRead} image${skippedRead > 1 ? 's' : ''}`)
    }
    if (skippedCap > 0) {
      parts.push(`Only ${MAX_IMAGES} images allowed`)
    }
    if (considered === 0) {
      parts.push('No image files found')
    }
    setImageError(parts.length ? parts.join(' · ') : null)
    if (next.length) setImages((prev) => [...prev, ...next].slice(0, MAX_IMAGES))
  }

  const removeImage = (index: number): void => {
    setImages((prev) => prev.filter((_, j) => j !== index))
    setImageError(null)
  }

  const clearImages = (): void => {
    setImages([])
    setImageError(null)
  }

  return {
    images,
    setImages,
    imageError,
    setImageError,
    onPickImages,
    removeImage,
    clearImages
  }
}
