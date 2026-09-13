import { BrowserWindow, type Input } from 'electron'
import { is } from '@electron-toolkit/utils'

function redispatchRendererKey(
  webContents: Electron.WebContents,
  input: Input,
  key: string,
  code: string
): void {
  const payload = JSON.stringify({
    key,
    code,
    ctrlKey: Boolean(input.control),
    metaKey: Boolean(input.meta),
    shiftKey: Boolean(input.shift),
    altKey: Boolean(input.alt),
    bubbles: true,
    cancelable: true
  })
  void webContents
    .executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', ${payload}))`)
    .catch(() => {
      /* window may be gone */
    })
}

function zoomShortcutKey(input: Input): string | null {
  switch (input.code) {
    case 'Minus':
    case 'NumpadSubtract':
      return input.shift ? '_' : '-'
    case 'Equal':
    case 'NumpadAdd':
      return input.shift ? '+' : '='
    case 'Digit0':
    case 'Numpad0':
      return '0'
    default:
      return null
  }
}

/**
 * Like `@electron-toolkit/utils` `optimizer.watchWindowShortcuts`, but does not
 * swallow Ctrl/Cmd+R in production. Packaged Chromium still must not reload the
 * window — we preventDefault and re-dispatch a page KeyboardEvent so Changes/PR
 * refresh handlers can run.
 *
 * Ctrl/Cmd +/- / 0 are blocked from Chromium page-zoom and re-dispatched so the
 * renderer can map them to Settings text size. Ctrl/Cmd+W is intercepted so the
 * default menu cannot close the window; the renderer closes the chat tab.
 */
export function watchWindowShortcuts(window: BrowserWindow): void {
  if (!window) return
  const { webContents } = window

  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return

    if (!is.dev) {
      if (input.code === 'KeyR' && (input.control || input.meta)) {
        event.preventDefault()
        redispatchRendererKey(webContents, input, 'r', 'KeyR')
        return
      }
      // Ignore DevTools open chords in production
      if (
        input.code === 'KeyI' &&
        ((input.alt && input.meta) || (input.control && input.shift))
      ) {
        event.preventDefault()
      }
    } else if (input.code === 'F12') {
      if (webContents.isDevToolsOpened()) {
        webContents.closeDevTools()
      } else {
        webContents.openDevTools({ mode: 'undocked' })
      }
    }

    if (input.control || input.meta) {
      if (!input.alt && !input.shift && input.code === 'KeyW') {
        event.preventDefault()
        redispatchRendererKey(webContents, input, 'w', 'KeyW')
        return
      }
      const zoomKey = zoomShortcutKey(input)
      if (zoomKey != null) {
        event.preventDefault()
        redispatchRendererKey(webContents, input, zoomKey, input.code)
      }
    }
  })
}
