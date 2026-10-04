import type { CustomScheme } from 'electron'

/** The sandboxed render/inspect page's own origin (src/main/video/renderHost.ts). */
export const RENDER_SCHEME = 'vyotiq-render'

/** Workspace and run media the app window plays (src/main/video/mediaProtocol.ts). */
export const MEDIA_SCHEME = 'vyotiq-media'

/**
 * Both schemes, for the one `protocol.registerSchemesAsPrivileged` call main
 * makes before `ready` — a second call would replace the first.
 *
 * `secure` makes the render page a secure context, which WebCodecs requires
 * (measured: `VideoEncoder` is undefined on a data: page in Electron 44).
 * `stream` lets a <video> read ranges of a large file instead of buffering it.
 */
export const VIDEO_SCHEMES: CustomScheme[] = [
  {
    scheme: RENDER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: false }
  },
  {
    scheme: MEDIA_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]
