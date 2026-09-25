import { resolve } from 'path'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { defineConfig, loadEnv } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Give the Node/Vite build and dev-server processes deliberate headroom.
//
// This does NOT raise the Electron main process: measured on Electron 43,
// `NODE_OPTIONS=--max-old-space-size=8192`, `--js-flags=--max-old-space-size=...`
// on the binary, and `v8.setFlagsFromString` all leave
// `v8.getHeapStatistics().heap_size_limit` at ~4192 MB — Chromium's
// pointer-compressed V8 cage caps old space near 4 GB and the flag must exist
// before the isolate is created. Packaged apps ignore NODE_OPTIONS entirely
// (Electron docs allow only --max-http-header-size/--http-parser). Main-process
// heap therefore MUST stay bounded by design: see `isHeapPressureHigh` and the
// append-queue/SSE caps; do not count on a bigger ceiling.
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--max-old-space-size=8192']
  .filter(Boolean)
  .join(' ')

/**
 * How long a superseded renderer chunk stays on disk.
 *
 * Long enough to outlive any app instance started earlier in the same working
 * session — that instance is the reason the chunk is kept at all.
 */
const RENDERER_ASSET_RETENTION_MS = 12 * 60 * 60 * 1000

/**
 * Drop superseded renderer chunks once nothing can still be running them.
 *
 * The renderer builds with `emptyOutDir: false`, so a rebuild adds the new
 * content-hashed chunks beside the old ones instead of deleting them. Without
 * that, a `pnpm build` while the app is running (an agent building this very
 * repo, say) pulls the chunks out from under the live window: its next lazy
 * import cannot resolve and the surface dies mid-session, which is what the
 * renderer's stale-chunk reload exists to survive. Keeping the old chunks means
 * a running window simply carries on with the build it started on.
 *
 * They still have to be collected, or `out/renderer/assets` grows by a whole
 * build every time. Age is the safe measure: the build just written is newest,
 * and anything past the retention window predates every live instance.
 */
function pruneSupersededRendererAssets(outDir: string): Plugin {
  return {
    name: 'vyotiq:prune-superseded-renderer-assets',
    apply: 'build',
    closeBundle() {
      const assetsDir = resolve(outDir, 'assets')
      const cutoff = Date.now() - RENDERER_ASSET_RETENTION_MS
      let pruned = 0
      let entries: string[]
      try {
        entries = readdirSync(assetsDir)
      } catch {
        return // nothing built yet
      }
      for (const entry of entries) {
        const full = resolve(assetsDir, entry)
        try {
          if (statSync(full).mtimeMs >= cutoff) continue
          rmSync(full, { force: true })
          pruned += 1
        } catch {
          // A file that vanished or is locked is not worth failing a build over.
        }
      }
      if (pruned > 0) console.log(`[vyotiq] pruned ${pruned} superseded renderer asset(s)`)
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const sentryDsn = env.SENTRY_DSN || env.VITE_SENTRY_DSN || ''

  const dsnDefine = {
    'process.env.SENTRY_DSN': JSON.stringify(sentryDsn),
    'process.env.VITE_SENTRY_DSN': JSON.stringify(sentryDsn)
  }

  // Vyotiq's own Google OAuth client for the hosted Gmail/Drive/Calendar MCP
  // servers. Those endpoints support no dynamic client registration, so without
  // this every user has to build a Google Cloud client by hand. Empty in a dev
  // checkout, which falls back to exactly that manual path.
  // Registered as a Desktop app client: the secret is non-confidential by
  // Google's own definition, and PKCE + the loopback redirect carry the flow.
  const googleMcpDefine = {
    'process.env.VYOTIQ_GOOGLE_MCP_CLIENT_ID': JSON.stringify(
      env.VYOTIQ_GOOGLE_MCP_CLIENT_ID || ''
    ),
    'process.env.VYOTIQ_GOOGLE_MCP_CLIENT_SECRET': JSON.stringify(
      env.VYOTIQ_GOOGLE_MCP_CLIENT_SECRET || ''
    )
  }

  const rendererOutDir = resolve('out/renderer')

  return {
    main: {
      envPrefix: ['VITE_', 'SENTRY_'],
      // Bake DSN + Google MCP client into packaged main (runtime process.env is
      // empty in production).
      define: { ...dsnDefine, ...googleMcpDefine },
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared')
        }
      },
      build: {
        minify: 'esbuild',
        rollupOptions: {
          input: {
            index: resolve('src/main/index.ts'),
            'tokenizer.worker': resolve('src/main/agent/context/tokenizer.worker.ts'),
            dictationUtility: resolve('src/main/dictation/whisperUtility.ts'),
            embedUtility: resolve('src/main/agent/codeindex/embed/embedUtility.ts')
          }
        }
      }
    },
    preload: {
      envPrefix: ['VITE_', 'SENTRY_'],
      resolve: {
        alias: {
          '@main': resolve('src/main'),
          '@shared': resolve('src/shared')
        }
      },
      // Sandboxed preload cannot require() node_modules — bundle everything in.
      build: {
        minify: 'esbuild',
        externalizeDeps: false,
        rollupOptions: {
          input: {
            index: resolve('src/preload/index.ts')
          }
        }
      },
      define: dsnDefine
    },
    renderer: {
      envPrefix: ['VITE_'],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared')
        }
      },
      plugins: [
        react({
          babel: {
            plugins: [['babel-plugin-react-compiler', { compilationMode: 'annotation' }]]
          }
        }),
        tailwindcss(),
        pruneSupersededRendererAssets(rendererOutDir)
      ],
      define: {
        'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(sentryDsn)
      },
      build: {
        minify: 'esbuild',
        // Never delete the chunks a running window is still lazily importing;
        // pruneSupersededRendererAssets collects them once they are old enough,
        // and `pack:*` clears the tree outright so no installer ships them.
        emptyOutDir: false,
        // A budget in place of Vite's 500 kB default, which is a download-size
        // heuristic for websites: this renderer loads from local disk, so it
        // warned on every build and was ignored. The entry chunk is the first
        // screen (the task record, navigator and inspector, react-dom, the icon
        // set, zod) at ~1.83 MB since the 1.0.0 redesign, and every other chunk
        // over 500 kB is one vendor library that already loads on demand
        // (mermaid's parser and core, CodeMirror, cytoscape). 2 MB leaves the
        // entry some room and still warns if a lazy library — even katex, the
        // smallest at ~0.26 MB — is pulled into it.
        chunkSizeWarningLimit: 2000,
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (
                id.includes('node_modules/react-markdown') ||
                id.includes('node_modules/remark-gfm') ||
                id.includes('node_modules/rehype-sanitize') ||
                id.includes('node_modules/hast-util-')
              ) {
                return 'markdown'
              }
              // No rule for shiki on purpose: markdownHighlight.ts imports
              // shiki/core and each grammar and theme lazily, and a manual
              // chunk folded all of them back into one 1.1 MB file that the
              // first code block of any language had to load whole.
              if (id.includes('node_modules/@lobehub/icons')) return 'lobehub'
              return undefined
            }
          }
        }
      }
    }
  }
})
