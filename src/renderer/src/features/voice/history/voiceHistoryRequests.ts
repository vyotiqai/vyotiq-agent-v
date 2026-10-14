/**
 * Open requests for the voice conversations dialog. They come from a brief
 * said by voice and the navigator's View menu; the dialog that answers them
 * is mounted once, in the app shell.
 */

let openRequest: ((workspacePath: string, id: string | null) => void) | null = null

/** Register the mounted dialog; returns the unregister. */
export function onVoiceConversationsRequest(open: (workspacePath: string, id: string | null) => void): () => void {
  openRequest = open
  return () => {
    if (openRequest === open) openRequest = null
  }
}

/** Open a workspace's voice conversations, or one of them. False when nothing is mounted to show it. */
export function requestVoiceConversations(workspacePath: string, id: string | null = null): boolean {
  if (!openRequest) return false
  openRequest(workspacePath, id)
  return true
}
