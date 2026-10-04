/**
 * Where mirrored terminal bytes go, if anywhere.
 *
 * Agent tools must stay runnable (and testable) without a window, so they do
 * not import the PTY session store directly — that module reaches BrowserWindow
 * and the Electron app layer. The app registers itself here during startup
 * instead; with no sink registered, mirroring is a no-op.
 *
 * Writes are also batched here, because this is the one seam every mirror write
 * already passes through: the command header, each stdout/stderr chunk, and the
 * exit/aborted footer all arrive as separate calls. A chatty command produces
 * hundreds of pipe reads a second, and one IPC message per read asks the
 * Terminal panel to redraw hundreds of times for a panel that paints at 60Hz.
 * Batching is safe because the flush is the exact concatenation of the writes
 * that went in, in order — the panel sees the same byte stream, just carried in
 * fewer messages.
 */

export type TerminalMirrorSink = (workspacePath: string, text: string) => void

/**
 * One animation frame at 60Hz: long enough to absorb a burst of pipe reads that
 * land in the same turn, short enough that a lone write is not visibly delayed
 * and that no panel redraw can fall more than one frame behind.
 */
export const MIRROR_FLUSH_MS = 16

let sink: TerminalMirrorSink | null = null

type PendingWrite = { text: string; timer: ReturnType<typeof setTimeout> | null }

/** One buffer per workspace: a write must never join another workspace's bytes. */
const pending = new Map<string, PendingWrite>()

function clearPending(workspacePath: string): PendingWrite | null {
  const entry = pending.get(workspacePath)
  if (!entry) return null
  pending.delete(workspacePath)
  if (entry.timer) clearTimeout(entry.timer)
  return entry
}

/**
 * Send what is buffered now. With a workspace path, only that workspace; with
 * none, every workspace in insertion order. Callers that are tearing a session
 * down call this first, so buffered bytes are delivered while the session they
 * belong to still exists.
 */
export function flushTerminalMirror(workspacePath?: string): void {
  if (!sink) return
  if (workspacePath) {
    const entry = clearPending(workspacePath)
    if (entry?.text) deliver(sink, workspacePath, entry.text)
    return
  }
  for (const path of [...pending.keys()]) {
    const entry = clearPending(path)
    if (entry?.text) deliver(sink, path, entry.text)
  }
}

function deliver(target: TerminalMirrorSink, workspacePath: string, text: string): void {
  try {
    target(workspacePath, text)
  } catch {
    // Mirroring is a view. It must never take down the command it is showing.
  }
}

export function setTerminalMirrorSink(next: TerminalMirrorSink | null): void {
  // Anything already buffered belongs to the sink that was just replaced —
  // flush it into the old one rather than dropping or re-ordering the bytes.
  if (sink) flushTerminalMirror()
  for (const path of [...pending.keys()]) clearPending(path)
  sink = next
}

export function writeTerminalMirror(workspacePath: string, text: string): void {
  if (!sink || !workspacePath || !text) return
  const entry = pending.get(workspacePath) ?? { text: '', timer: null }
  entry.text += text
  if (!entry.timer) {
    entry.timer = setTimeout(() => flushTerminalMirror(workspacePath), MIRROR_FLUSH_MS)
    entry.timer.unref?.()
  }
  pending.set(workspacePath, entry)
}