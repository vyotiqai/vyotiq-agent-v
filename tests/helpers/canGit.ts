import { execFileSync } from 'child_process'

/** True when `git` is on PATH (probe via `--version`). */
export const canGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
