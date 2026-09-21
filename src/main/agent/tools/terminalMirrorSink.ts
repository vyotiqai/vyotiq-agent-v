/**
 * Where mirrored terminal bytes go, if anywhere.
 *
 * Agent tools must stay runnable (and testable) without a window, so they do
 * not import the PTY session store directly — that module reaches BrowserWindow
 * and the Electron app layer. The app registers itself here during startup
 * instead; with no sink registered, mirroring is a no-op.
 */

export type TerminalMirrorSink = (workspacePath: string, text: string) => void

let sink: TerminalMirrorSink | null = null

export function setTerminalMirrorSink(next: TerminalMirrorSink | null): void {
  sink = next
}

export function writeTerminalMirror(workspacePath: string, text: string): void {
  if (!sink || !workspacePath || !text) return
  try {
    sink(workspacePath, text)
  } catch {
    // Mirroring is a view. It must never take down the command it is showing.
  }
}
