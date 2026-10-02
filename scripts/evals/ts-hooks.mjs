/**
 * Module hooks that let plain Node (or an Electron main process) import the
 * src/main TypeScript graph directly — the agent loop included — without a
 * build step. Same idea as scripts/arc-agi/resolve-shim.mjs, extended for
 * what the loop's graph needs:
 *
 * - `@main/*` and `@shared/*` aliases, extensionless and directory specifiers
 * - TypeScript with parameter properties (`transform` mode, not strip-only)
 * - electron-vite `?asset` imports (resolved to the path string)
 * - extensionless package subpaths (`ajv/dist/2020`) via require.resolve
 * - optionally, 'electron' -> scripts/evals/electron-stub.mjs
 *
 * Register BEFORE the first dynamic import of a .ts module: static imports
 * are resolved before the importing module's body runs.
 */
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks, stripTypeScriptTypes } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const workspaceRoot = resolve(here, '..', '..')
const ALIASES = { '@main/': 'src/main/', '@shared/': 'src/shared/' }

let registered = false

/** Returns false when this runtime lacks registerHooks/stripTypeScriptTypes. */
export function registerEvalHooks({ electronStub = false } = {}) {
  if (registered) return true
  if (typeof registerHooks !== 'function' || typeof stripTypeScriptTypes !== 'function') return false
  const stubUrl = pathToFileURL(join(here, 'electron-stub.mjs')).href

  const tryResolve = (candidates, context, nextResolve) => {
    for (const candidate of candidates) {
      try {
        return nextResolve(candidate, context)
      } catch {
        // next candidate
      }
    }
    return null
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'electron' && electronStub) return { url: stubUrl, shortCircuit: true }
      if (specifier.includes('?asset')) {
        const target = specifier.slice(0, specifier.indexOf('?asset'))
        const abs = context.parentURL ? fileURLToPath(new URL(target, context.parentURL)) : target
        return { url: `data:text/javascript,export default ${encodeURIComponent(JSON.stringify(abs))}`, shortCircuit: true }
      }
      const alias = Object.keys(ALIASES).find((prefix) => specifier.startsWith(prefix))
      let spec = specifier
      if (alias) spec = pathToFileURL(join(workspaceRoot, ALIASES[alias], specifier.slice(alias.length))).href
      const isPathLike = alias || spec.startsWith('./') || spec.startsWith('../')
      if (isPathLike && !/\.[cm]?[jt]sx?$/i.test(spec)) {
        const hit = tryResolve([`${spec}.ts`, `${spec}/index.ts`], context, nextResolve)
        if (hit) return hit
      }
      try {
        return nextResolve(spec, context)
      } catch (err) {
        const bare = !isPathLike && !spec.startsWith('node:') && !spec.includes(':')
        if (!bare || !context.parentURL) throw err
        // Package subpaths without an extension (`ajv/dist/2020`) that a
        // bundler accepts and strict ESM resolution does not.
        const required = createRequire(context.parentURL).resolve(spec)
        return { url: pathToFileURL(required).href, shortCircuit: true }
      }
    },
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && /\.m?ts$/.test(new URL(url).pathname) && !url.includes('/node_modules/')) {
        const source = readFileSync(fileURLToPath(url), 'utf8')
        return {
          format: 'module',
          source: stripTypeScriptTypes(source, { mode: 'transform', sourceMap: true, sourceUrl: url }),
          shortCircuit: true
        }
      }
      return nextLoad(url, context)
    }
  })
  registered = true
  return true
}
