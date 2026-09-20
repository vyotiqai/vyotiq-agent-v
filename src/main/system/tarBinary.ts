import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Absolute path to the tar implementation to spawn, or plain `tar` elsewhere.
 *
 * Windows has shipped bsdtar at %SystemRoot%\System32\tar.exe since Windows 10
 * 1803, and every archive path this app passes is absolute (Electron userData
 * lives under C:\Users\...). GNU tar — which is what `tar` resolves to when
 * Git for Windows' optional Unix tools, MSYS2 or Cygwin are ahead of System32
 * on PATH — reads `C:\Users\...\pkg.tgz` as the rsh syntax `host:path` and
 * fails with "tar (child): Cannot connect to C: resolve failed". Which binary
 * wins is therefore a property of the user's PATH, not of this code, and a
 * developer machine can silently break marketplace installs.
 *
 * `--force-local` would tell GNU tar to stop doing that, but bsdtar rejects the
 * flag outright, so there is no single argument list that suits both. Naming
 * the system binary removes the ambiguity instead of guessing which tar ran.
 */
export function tarBinary(): string {
  if (process.platform !== 'win32') return 'tar'
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT
  if (!systemRoot) return 'tar'
  const systemTar = join(systemRoot, 'System32', 'tar.exe')
  return existsSync(systemTar) ? systemTar : 'tar'
}
