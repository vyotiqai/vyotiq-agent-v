/**
 * Shared Node resolve shim (Wave 4).
 *
 * The TS sources under src/main use extensionless relative imports
 * (e.g. orchestrator.ts imports './arcScorer'), which vitest and tsc resolve
 * fine under moduleResolution "bundler" — but Node's built-in type stripping
 * does not resolve extensions. This resolve hook appends '.ts' to
 * extensionless relative specifiers (with a '<dir>/index.ts' fallback for
 * directory specifiers like '../providers') and maps the bundler path aliases
 * '@main/...' and '@shared/...' so plain-Node/Electron entrypoints can import
 * the real src modules directly. No dependencies added.
 *
 * Consumers must register this hook BEFORE any dynamic import of a .ts module:
 * static ESM imports are resolved before the module body runs, so the hook
 * would register too late for them.
 */
import { registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const workspaceRoot = resolve(scriptDir, '..', '..')

/** True when the calling runtime supports node:module registerHooks. */
export function hasRegisterHooks() {
  return typeof registerHooks === 'function'
}

/**
 * Register the resolve shim. Idempotent per process. Returns true when the
 * hook was (or already had been) registered; false when the runtime has no
 * registerHooks support — callers should report that instead of guessing.
 */
let registered = false
export function registerResolveShim() {
  if (registered) return true
  if (typeof registerHooks !== 'function') return false
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../')
      const hasRuntimeExt = /\.[cm]?[jt]s$/i.test(specifier)

      // Bundler path aliases (vitest.config.ts, electron.vite.config.ts):
      // '@main/...' -> <root>/src/main/..., '@shared/...' -> <root>/src/shared/....
      // Plain Node ESM cannot resolve these, so map them onto the same
      // extensionless-resolution logic used for relative specifiers.
      if (/^@(?:main|shared)\//.test(specifier)) {
        const rootDir = specifier.startsWith('@main/') ? 'src/main' : 'src/shared'
        const rest = specifier.slice(specifier.indexOf('/') + 1)
        const base = pathToFileURL(join(workspaceRoot, rootDir, rest)).href
        if (!hasRuntimeExt) {
          try {
            return nextResolve(`${base}.ts`, context)
          } catch {
            try {
              return nextResolve(`${base}/index.ts`, context)
            } catch {
              // fall through to the default resolution
            }
          }
        }
        return nextResolve(base, context)
      }

      if (isRelative && !hasRuntimeExt) {
        try {
          return nextResolve(`${specifier}.ts`, context)
        } catch {
          // directory specifier (e.g. harnessAdapter's '../providers') - try its index.ts
          try {
            return nextResolve(`${specifier}/index.ts`, context)
          } catch {
            // fall through to the default resolution
          }
        }
      }
      return nextResolve(specifier, context)
    }
  })
  registered = true
  return true
}
