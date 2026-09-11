import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const sentryDsn = env.SENTRY_DSN || env.VITE_SENTRY_DSN || ''

  const dsnDefine = {
    'process.env.SENTRY_DSN': JSON.stringify(sentryDsn),
    'process.env.VITE_SENTRY_DSN': JSON.stringify(sentryDsn)
  }

  return {
    main: {
      envPrefix: ['VITE_', 'SENTRY_'],
      // Bake DSN into packaged main (runtime process.env is empty in production).
      define: dsnDefine,
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
            embedUtility: resolve('src/main/agent/codeindex/embedUtility.ts'),
            dictationUtility: resolve('src/main/dictation/whisperUtility.ts')
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
        tailwindcss()
      ],
      define: {
        'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(sentryDsn)
      },
      build: {
        minify: 'esbuild',
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
              if (id.includes('node_modules/shiki')) return 'shiki'
              if (id.includes('node_modules/@lobehub/icons')) return 'lobehub'
              return undefined
            }
          }
        }
      }
    }
  }
})
