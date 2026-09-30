import { useCallback, useRef, useState } from 'react'
import { ActionMenu, IconButton, type ActionMenuItem } from '@renderer/lib/ui'
import { MAX_IMAGES } from './useComposerImages'

/** A run's browser captures, by the name `runs:readArtifact` accepts. */
const SNAPSHOT_NAME_RE = /^browser\/snapshot(?:-[\w.-]+)?\.jpg$/

/** The run-dir artifact name for a capture main saved at `path`. */
export function browserSnapshotArtifactName(path: string): string {
  const name = `browser/${path.split(/[\\/]/).pop() ?? ''}`
  return SNAPSHOT_NAME_RE.test(name) ? name : 'browser/snapshot.jpg'
}

export type BrowserScreenshotAttach = {
  busy: boolean
  take: () => void
}

/**
 * A screenshot of the built-in Browser tab, attached as an image. It is the
 * capture the tab's own "Take screenshot" makes, saved with the task's run,
 * then read back from the run like the @browser mention reads its snapshot —
 * so it needs a run: the New task page has none, and gets no entry.
 *
 * Nothing is asked before the capture: main's browser state is the page the
 * Browser panel shows, which can be another workspace's, while the capture
 * takes this workspace's own tab. The capture says when there is no page.
 */
export function useBrowserScreenshotAttach({
  workspacePath,
  runId,
  onImage,
  onError
}: {
  workspacePath: string | null | undefined
  runId: string | null | undefined
  onImage: (dataUrl: string) => void
  onError: (message: string) => void
}): BrowserScreenshotAttach | null {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const api = typeof window !== 'undefined' ? window.vyotiq : undefined
  const available = Boolean(
    workspacePath && runId && api?.browserTakeScreenshot && api?.readRunArtifact
  )

  const take = useCallback((): void => {
    if (!workspacePath || !runId || busyRef.current) return
    const bridge = window.vyotiq
    if (!bridge?.browserTakeScreenshot || !bridge.readRunArtifact) return
    busyRef.current = true
    setBusy(true)
    void (async () => {
      try {
        const shot = await bridge.browserTakeScreenshot({ workspacePath, runId })
        if (!shot?.ok) {
          onError(
            shot && /no browser page open/i.test(shot.error)
              ? 'No page is open in the Browser tab.'
              : `The Browser tab could not be captured${shot?.error ? `: ${shot.error}` : '.'}`
          )
          return
        }
        const read = await bridge.readRunArtifact({
          workspacePath,
          runId,
          name: browserSnapshotArtifactName(shot.data.path)
        })
        if (read?.ok && read.data.exists && read.data.content) onImage(read.data.content)
        else onError('The screenshot was taken but could not be read back.')
      } catch {
        onError('The Browser tab could not be captured.')
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    })()
  }, [workspacePath, runId, onImage, onError])

  return available ? { busy, take } : null
}

/**
 * The paperclip as a small menu: Files (the picker for anything the box
 * reads), Image (the same picker, images only), and a screenshot of the
 * Browser tab when the task has a run to keep it with.
 */
export function AttachMenu({
  label,
  disabled,
  imagesFull,
  onPickFiles,
  onPickImage,
  screenshot
}: {
  /** The trigger's name — it carries the per-kind room left once something is full. */
  label: string
  disabled: boolean
  imagesFull: boolean
  onPickFiles: () => void
  onPickImage: () => void
  screenshot: BrowserScreenshotAttach | null
}) {
  const [open, setOpen] = useState(false)
  const imagesFullReason = `You can attach up to ${MAX_IMAGES} images`
  const items: ActionMenuItem[] = [
    { id: 'files', label: 'Files…', icon: 'file', onSelect: onPickFiles },
    {
      id: 'image',
      label: 'Image…',
      icon: 'image',
      disabled: imagesFull,
      disabledReason: imagesFullReason,
      onSelect: onPickImage
    }
  ]
  if (screenshot) {
    items.push({
      id: 'screenshot',
      label: screenshot.busy ? 'Capturing the Browser tab…' : 'Screenshot of the Browser tab',
      icon: 'browser',
      disabled: imagesFull || screenshot.busy,
      disabledReason: imagesFull ? imagesFullReason : 'A capture is under way',
      onSelect: screenshot.take
    })
  }

  return (
    <ActionMenu
      open={open}
      onOpenChange={setOpen}
      placement="up"
      align="end"
      aria-label="Attach"
      items={items}
      trigger={(t) => (
        <IconButton
          ref={t.ref}
          icon="paperclip"
          label={label}
          // The open menu says what it offers; its name would sit over it.
          title={open ? '' : undefined}
          size="md"
          tone="muted"
          disabled={disabled}
          data-composer-attach
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          // No mousedown guard: the menu takes focus anyway, and a click that
          // left the text box focused would hand the menu its focus ring.
          onClick={t.onClick}
        />
      )}
    />
  )
}
