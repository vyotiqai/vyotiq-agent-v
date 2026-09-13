import {
  appendPtyOutputBuffer,
  prunePtyOutputBuffers,
  PTY_OUTPUT_BUFFER_MAX_CHARS
} from '@shared/utils/ptyOutputBuffer'

/** Module-level scrollback — survives Terminal panel unmount while PTY keeps running. */
const ptyOutputBuffers = new Map<string, string>()

let listenerStarted = false

/** Start (once) listening for PTY data so buffers fill even when the panel is closed. */
export function ensurePtyOutputBufferListener(): Map<string, string> {
  if (!listenerStarted && typeof window !== 'undefined') {
    listenerStarted = true
    window.vyotiq?.onPtyData?.(({ id, data }) => {
      appendPtyOutputBuffer(ptyOutputBuffers, id, data)
    })
    // Keep scrollback for exited-but-listed sessions; prune on kill/remove via prunePtyOutputBuffers.
  }
  return ptyOutputBuffers
}

export function getPtyOutputBuffers(): Map<string, string> {
  return ensurePtyOutputBufferListener()
}

export function pruneLivePtyBuffers(liveIds: Iterable<string>): void {
  prunePtyOutputBuffers(ptyOutputBuffers, liveIds)
}

export { PTY_OUTPUT_BUFFER_MAX_CHARS }
