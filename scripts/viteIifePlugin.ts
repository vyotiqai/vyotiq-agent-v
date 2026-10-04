import { build, type Plugin, type Rollup } from 'vite'

const SUFFIX = '?iife'
const PREFIX = '\0vyotiq-iife:'

/**
 * `import source from './page?iife'` → the module bundled (with its npm
 * dependencies) into one self-running browser script, as a string.
 *
 * Main uses it to serve the video runner (src/videoRunner/runner.ts) to the
 * sandboxed render window from memory: that page has no Node, no preload and
 * no route back to the app's files, so whatever it runs must arrive whole.
 * Built with Vite itself, so electron-vite and vitest both resolve it the same
 * way and no bundler dependency is added.
 */
export function iifeBundlePlugin(): Plugin {
  const cache = new Map<string, Promise<string>>()
  return {
    name: 'vyotiq:iife-bundle',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(SUFFIX)) return null
      const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, { skipSelf: true })
      return resolved ? `${PREFIX}${resolved.id}` : null
    },
    async load(id) {
      if (!id.startsWith(PREFIX)) return null
      const entry = id.slice(PREFIX.length)
      this.addWatchFile(entry)
      let pending = cache.get(entry)
      if (!pending) {
        pending = bundle(entry)
        cache.set(entry, pending)
        pending.catch(() => cache.delete(entry))
      }
      return `export default ${JSON.stringify(await pending)}`
    },
    watchChange(changed) {
      // Any edit under the runner's folder rebuilds it on the next load.
      for (const entry of cache.keys()) {
        if (changed.replace(/\\/g, '/').startsWith(entry.replace(/\\/g, '/').replace(/[^/]+$/, ''))) cache.delete(entry)
      }
    }
  }
}

async function bundle(entry: string): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      emptyOutDir: false,
      minify: 'esbuild',
      target: 'chrome140',
      reportCompressedSize: false,
      lib: { entry, formats: ['iife'], name: '__vyotiqIife', fileName: () => 'bundle.js' },
      rollupOptions: { output: { inlineDynamicImports: true } }
    }
  })
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[]
  const chunk = outputs.flatMap((o) => o.output).find((c): c is Rollup.OutputChunk => c.type === 'chunk')
  if (!chunk) throw new Error(`iife bundle of ${entry} produced no script`)
  return chunk.code
}
