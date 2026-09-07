import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction
} from 'react'
import type {
  AttachedAudio,
  AttachedFile,
  AttachedNativeFile,
  ComposerSendExtras,
  SlashCommandDescriptor
} from '@shared/ipc'
import { parseSlashSubmit } from '@shared/slashCommands'
import { findSlashChipSubmit, hasComposerContent } from './mentionModel'
import type { MentionMenuItem } from './mentionModel'

/** Build the native-file / audio extras payload from a cleared draft, if any. */
function buildExtras(
  nativeFiles: AttachedNativeFile[],
  audio: AttachedAudio[]
): ComposerSendExtras | undefined {
  return nativeFiles.length || audio.length
    ? {
        ...(nativeFiles.length ? { nativeFiles: nativeFiles } : {}),
        ...(audio.length ? { audio: audio } : {})
      }
    : undefined
}

export function useComposerDraft({
  draft,
  onDraftChange,
  images,
  setImages,
  setImageError,
  files,
  setFiles,
  nativeFiles = [],
  setNativeFiles,
  audio = [],
  setAudio,
  setFileError,
  disabled,
  sendBlocked,
  onSend,
  slashMenuOpen,
  slashActiveCommand,
  onSlashMove,
  onSlashDismiss,
  onSlashAccept,
  onSlashSubmit,
  resolveSlashSubmitCommand,
  onSlashResolveError,
  mentionMenuOpen,
  mentionActiveItem,
  onMentionMove,
  onMentionDismiss,
  onMentionAccept,
  onMentionBack,
  onEditLastUserMessage,
  onCancelEdit,
  getCaretStart,
  onSubmitted
}: {
  draft?: string
  onDraftChange?: (draft: string) => void
  images: string[]
  setImages: Dispatch<SetStateAction<string[]>>
  setImageError: (error: string | null) => void
  files: AttachedFile[]
  setFiles: Dispatch<SetStateAction<AttachedFile[]>>
  nativeFiles?: AttachedNativeFile[]
  setNativeFiles?: Dispatch<SetStateAction<AttachedNativeFile[]>>
  audio?: AttachedAudio[]
  setAudio?: Dispatch<SetStateAction<AttachedAudio[]>>
  setFileError: (error: string | null) => void
  disabled?: boolean
  sendBlocked?: boolean
  onSend: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  slashMenuOpen?: boolean
  slashActiveCommand?: SlashCommandDescriptor | null
  onSlashMove?: (delta: number) => void
  onSlashDismiss?: () => void
  onSlashAccept?: (command: SlashCommandDescriptor) => void
  /** When set, intercepts submit that starts with `/command`. Return true if handled. */
  onSlashSubmit?: (
    command: SlashCommandDescriptor,
    trailingText: string,
    images: string[],
    files: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  /** Exact / active-prefix / fuzzy-prefix resolve for slash submit (loads catalog if empty). */
  resolveSlashSubmitCommand?: (
    trigger: string
  ) => SlashCommandDescriptor | null | Promise<SlashCommandDescriptor | null>
  onSlashResolveError?: (message: string) => void
  mentionMenuOpen?: boolean
  mentionActiveItem?: MentionMenuItem | null
  onMentionMove?: (delta: number) => void
  onMentionDismiss?: () => void
  onMentionAccept?: (item: MentionMenuItem) => void
  onMentionBack?: () => boolean
  /** Dock composer: ArrowUp on empty draft or caret at start. Return true if edit began. */
  onEditLastUserMessage?: () => boolean
  /** Inline edit: Escape cancels the replacement composer. */
  onCancelEdit?: () => void
  getCaretStart?: () => number
  /** Runs after a send is dispatched (Enter, button, or slash) so callers can
   *  restore composer focus — the contentEditable never fires form submit. */
  onSubmitted?: () => void
}) {
  const [internalText, setInternalText] = useState('')
  const isDraftControlled = draft !== undefined && onDraftChange !== undefined
  const text = isDraftControlled ? draft : internalText
  const rawSetText = isDraftControlled ? onDraftChange : setInternalText
  const textRef = useRef(text)
  const imagesRef = useRef(images)
  const filesRef = useRef(files)
  const nativeFilesRef = useRef(nativeFiles)
  const audioRef = useRef(audio)
  const submissionRef = useRef(0)
  const submittingRef = useRef(false)
  textRef.current = text
  imagesRef.current = images
  filesRef.current = files
  nativeFilesRef.current = nativeFiles
  audioRef.current = audio
  const setText = useCallback(
    (next: string): void => {
      // Whitespace-only drafts carry no sendable content — normalize to empty so
      // invisible blank lines (typing, dictation, paste) can never stretch the
      // composer body or wedge the primary action behind phantom content.
      const normalized = next.trim() === '' ? '' : next
      textRef.current = normalized
      rawSetText(normalized)
    },
    [rawSetText]
  )
  const hasAttachments =
    images.length > 0 || files.length > 0 || nativeFiles.length > 0 || audio.length > 0
  const canSend = (hasComposerContent(text) || hasAttachments) && !disabled && !sendBlocked

  const clearDraft = useCallback((submissionId: number): {
    draftText: string
    draftImages: string[]
    draftFiles: AttachedFile[]
    draftNative: AttachedNativeFile[]
    draftAudio: AttachedAudio[]
    restore: () => void
  } => {
    const draftText = text
    const draftImages = images
    const draftFiles = files
    const draftNative = nativeFiles
    const draftAudio = audio
    const restore = (): void => {
      if (submissionRef.current !== submissionId) return
      if (textRef.current === '') setText(draftText)
      if (imagesRef.current.length === 0) setImages(draftImages)
      if (filesRef.current.length === 0) setFiles(draftFiles)
      if (nativeFilesRef.current.length === 0) setNativeFiles?.(draftNative)
      if (audioRef.current.length === 0) setAudio?.(draftAudio)
    }
    textRef.current = ''
    imagesRef.current = []
    filesRef.current = []
    nativeFilesRef.current = []
    audioRef.current = []
    setText('')
    setImages([])
    setImageError(null)
    setFiles([])
    setNativeFiles?.([])
    setAudio?.([])
    setFileError(null)
    return { draftText, draftImages, draftFiles, draftNative, draftAudio, restore }
  }, [
    text,
    images,
    files,
    nativeFiles,
    audio,
    setText,
    setImages,
    setImageError,
    setFiles,
    setNativeFiles,
    setAudio,
    setFileError
  ])

  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (
      (!hasComposerContent(text) && !hasAttachments) ||
      disabled ||
      sendBlocked ||
      submittingRef.current
    ) return
    submittingRef.current = true
    onSubmitted?.()
    const submissionId = ++submissionRef.current

    const slashChip = findSlashChipSubmit(text)
    if (slashChip && onSlashSubmit && resolveSlashSubmitCommand) {
      // Resolve against a loaded catalog before clearing — chip remounts often have
      // an empty in-memory list (list IPC is deferred until `/` is typed).
      const trailingRaw = slashChip.trailingRaw
      const commandId = slashChip.commandId
      const trigger = slashChip.trigger
      void Promise.resolve()
        .then(async () => {
          const cmd =
            (commandId ? await resolveSlashSubmitCommand(commandId) : null) ??
            (await resolveSlashSubmitCommand(trigger))
          if (!cmd) {
            // Do not fall through: resolveComposerMentions strips slash chips and
            // would send trailing text without the skill/MCP body.
            onSlashResolveError?.(
              'That command is no longer available. Remove the chip and choose it again.'
            )
            return false
          }
          const { draftImages, draftFiles, draftNative, draftAudio, restore } = clearDraft(submissionId)
          const extras = buildExtras(draftNative, draftAudio)
          try {
            const ok = await onSlashSubmit(
              cmd,
              trailingRaw,
              draftImages,
              draftFiles,
              extras
            )
            if (ok === false) restore()
          } catch {
            restore()
          }
        })
        .finally(() => {
          submittingRef.current = false
        })
      return
    }

    const parsed = parseSlashSubmit(text)
    if (parsed && onSlashSubmit && resolveSlashSubmitCommand) {
      const trailingText = parsed.trailingText
      const trigger = parsed.trigger
      void Promise.resolve()
        .then(async () => {
          const cmd = await resolveSlashSubmitCommand(trigger)
          if (!cmd) {
            // Unknown slash → fall through as normal chat message
            const { draftText, draftImages, draftFiles, draftNative, draftAudio, restore } =
              clearDraft(submissionId)
            const extras = buildExtras(draftNative, draftAudio)
            try {
              const ok = await onSend(
                draftText,
                draftImages.length ? draftImages : undefined,
                draftFiles.length ? draftFiles : undefined,
                extras
              )
              if (ok === false) restore()
            } catch {
              restore()
            }
            return
          }
          const { draftImages, draftFiles, draftNative, draftAudio, restore } = clearDraft(submissionId)
          const extras = buildExtras(draftNative, draftAudio)
          try {
            const ok = await onSlashSubmit(
              cmd,
              trailingText,
              draftImages,
              draftFiles,
              extras
            )
            if (ok === false) restore()
          } catch {
            restore()
          }
        })
        .finally(() => {
          submittingRef.current = false
        })
      return
    }

    const { draftText, draftImages, draftFiles, draftNative, draftAudio, restore } = clearDraft(submissionId)
    const extras = buildExtras(draftNative, draftAudio)
    void Promise.resolve()
      .then(() =>
        onSend(
          draftText,
          draftImages.length ? draftImages : undefined,
          draftFiles.length ? draftFiles : undefined,
          extras
        )
      )
      .then((ok) => {
        if (ok === false) restore()
      }, restore)
      .finally(() => {
        submittingRef.current = false
      })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>): void => {
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        onSlashMove?.(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onSlashMove?.(-1)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onSlashDismiss?.()
        return
      }
      if (
        e.key === 'Tab' ||
        (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)
      ) {
        if (slashActiveCommand) {
          e.preventDefault()
          onSlashAccept?.(slashActiveCommand)
          return
        }
      }
    }
    if (mentionMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        onMentionMove?.(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        onMentionMove?.(-1)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (onMentionBack?.()) return
        onMentionDismiss?.()
        return
      }
      if (e.key === 'Backspace' && onMentionBack?.()) {
        e.preventDefault()
        return
      }
      if (
        e.key === 'Tab' ||
        (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)
      ) {
        if (mentionActiveItem) {
          e.preventDefault()
          onMentionAccept?.(mentionActiveItem)
          return
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && onCancelEdit) {
      e.preventDefault()
      e.stopPropagation()
      onCancelEdit()
      return
    }
    if (
      e.key === 'ArrowUp' &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing &&
      onEditLastUserMessage
    ) {
      const empty = !hasComposerContent(text)
      const caret = getCaretStart?.() ?? 0
      if (!empty && caret !== 0) return
      if (!onEditLastUserMessage()) return
      e.preventDefault()
    }
  }

  return { text, setText, canSend, submit, onKeyDown, clearDraft }
}
