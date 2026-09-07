import { useState } from 'react'
import type { AttachedAudio, AttachedFile, AttachedNativeFile } from '@shared/ipc'
import { parseOpenableAttachmentPath } from '@shared/utils/linkableWorkspacePath'
import { FileChip, ImageChip, ImageLightbox } from '@renderer/lib/ui'
import { useRunSession } from '../../RunSessionContext'

export function ComposerAttachments({
  images,
  imageError,
  files = [],
  nativeFiles = [],
  audio = [],
  fileError = null,
  audioError = null,
  extracting = false,
  attachLocked,
  onRemove,
  onRemoveFile,
  onRemoveNativeFile,
  onRemoveAudio
}: {
  images: string[]
  imageError: string | null
  files?: AttachedFile[]
  nativeFiles?: AttachedNativeFile[]
  audio?: AttachedAudio[]
  fileError?: string | null
  audioError?: string | null
  extracting?: boolean
  attachLocked: boolean
  onRemove: (index: number) => void
  onRemoveFile?: (index: number) => void
  onRemoveNativeFile?: (index: number) => void
  onRemoveAudio?: (index: number) => void
}) {
  const { onOpenWorkspaceFile } = useRunSession()
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)
  const notice = [imageError, fileError, audioError].filter(Boolean).join(' · ')

  const openAttachment = (name: string): (() => void) | undefined => {
    if (!onOpenWorkspaceFile) return undefined
    const parsed = parseOpenableAttachmentPath(name)
    if (!parsed) return undefined
    return () => onOpenWorkspaceFile(parsed.path, parsed.line ? { line: parsed.line } : undefined)
  }
  const hasChips = images.length || files.length || nativeFiles.length || audio.length
  if (!hasChips && !notice && !extracting) return null

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      {hasChips ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {images.map((url, i) => (
            <ImageChip
              key={`${i}-${url.slice(0, 24)}`}
              url={url}
              label={`Image ${i + 1}`}
              disabled={attachLocked}
              onClick={() => setLightbox({ url, label: `Image ${i + 1}` })}
              onRemove={() => onRemove(i)}
            />
          ))}
          {files.map((file, i) => (
            <FileChip
              key={`${i}-${file.name}`}
              name={file.name}
              chars={file.text.length}
              disabled={attachLocked}
              onOpen={openAttachment(file.name)}
              onRemove={onRemoveFile ? () => onRemoveFile(i) : undefined}
            />
          ))}
          {nativeFiles.map((file, i) => (
            <FileChip
              key={`native-${i}-${file.name}`}
              name={file.name}
              chars={Math.ceil((file.data.length * 3) / 4)}
              disabled={attachLocked}
              onOpen={openAttachment(file.name)}
              onRemove={onRemoveNativeFile ? () => onRemoveNativeFile(i) : undefined}
            />
          ))}
          {audio.map((clip, i) => (
            <FileChip
              key={`audio-${i}`}
              name={clip.mime || 'audio'}
              chars={Math.ceil((clip.url.length * 3) / 4)}
              disabled={attachLocked}
              onRemove={onRemoveAudio ? () => onRemoveAudio(i) : undefined}
            />
          ))}
        </div>
      ) : null}
      {extracting ? (
        <p className="m-0 text-xs text-secondary" role="status">
          Reading attachment…
        </p>
      ) : null}
      {notice ? (
        <p className="m-0 text-xs text-danger" role="alert">
          {notice}
        </p>
      ) : null}
      {lightbox ? (
        <ImageLightbox
          url={lightbox.url}
          label={lightbox.label}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  )
}
