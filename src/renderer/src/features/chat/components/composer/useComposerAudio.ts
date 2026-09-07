import { useCallback, useState } from 'react'
import { MAX_AUDIO_BYTES, type AttachedAudio } from '@shared/ipc'
import {
  getComposerAttachments,
  setComposerAttachments,
  useComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'

export const MAX_AUDIO_FILES = 2

const ALLOWED_AUDIO_MIME = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/webm',
  'audio/ogg'
])

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read audio'))
    reader.readAsDataURL(file)
  })
}

export function isAudioFile(file: File): boolean {
  if (file.type && ALLOWED_AUDIO_MIME.has(file.type)) return true
  return /\.(wav|mp3|m4a|webm|ogg)$/i.test(file.name)
}

/** Audio attachments persist across Composer remounts when persistKey is set. */
export function useComposerAudio(persistKey?: string | null) {
  const persisted = useComposerAttachments(persistKey)
  const [localAudio, setLocalAudio] = useState<AttachedAudio[]>([])
  const [audioError, setAudioError] = useState<string | null>(null)

  const audio = persistKey ? persisted.audio : localAudio
  const setAudio = useCallback(
    (next: AttachedAudio[] | ((prev: AttachedAudio[]) => AttachedAudio[])): void => {
      if (persistKey) {
        const value = typeof next === 'function' ? next(getComposerAttachments(persistKey).audio) : next
        setComposerAttachments(persistKey, { audio: value })
      } else {
        setLocalAudio(next)
      }
    },
    [persistKey]
  )

  const addAudio = async (picked: File[]): Promise<void> => {
    if (!picked.length) return
    const room = MAX_AUDIO_FILES - audio.length
    if (room <= 0) {
      setAudioError(`At most ${MAX_AUDIO_FILES} audio files`)
      return
    }
    const next: AttachedAudio[] = []
    for (const file of picked.slice(0, room)) {
      if (!isAudioFile(file)) {
        setAudioError(`Unsupported audio type: ${file.name}`)
        continue
      }
      if (file.size > MAX_AUDIO_BYTES) {
        setAudioError(`${file.name} exceeds ${Math.round(MAX_AUDIO_BYTES / (1024 * 1024))} MB`)
        continue
      }
      const url = await readAsDataUrl(file)
      next.push({
        type: 'audio',
        url,
        mime: file.type || 'audio/mpeg'
      })
    }
    if (next.length) {
      setAudio((prev) => [...prev, ...next].slice(0, MAX_AUDIO_FILES))
      setAudioError(null)
    }
  }

  const removeAudio = (index: number): void => {
    setAudio((prev) => prev.filter((_, i) => i !== index))
  }

  const clearAudio = (): void => setAudio([])

  return { audio, setAudio, audioError, setAudioError, addAudio, removeAudio, clearAudio }
}
