/**
 * Hold a tag release until CI has passed on the tagged commit.
 *
 * The runbook pushes main and the tag together (`git push --follow-tags`), so
 * CI and Release start at the same moment. Release's own `verify` job runs
 * only typecheck and unit tests on Ubuntu; lint, the build, the audit, the
 * packaging smoke and GUI e2e on three platforms live in ci.yml. This waits
 * for a ci.yml run on the same commit and fails the release unless one
 * succeeded, so a commit CI rejects can never be published.
 *
 * Any successful run on the commit counts, including a re-run after a flake.
 * A cancelled run (CI cancels an older push to main when a newer one lands)
 * is a failure here: re-run CI on that commit, then re-run the release.
 *
 * Env: GITHUB_SHA, GITHUB_REPOSITORY (set by Actions), GH_TOKEN for `gh`.
 * Optional: CI_WORKFLOW (ci.yml), CI_WAIT_MINUTES (120),
 * CI_WAIT_NO_RUN_MINUTES (15), CI_POLL_SECONDS (60).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ databaseId: number, status: string, conclusion: string, event: string, url: string }} CiRun
 * @typedef {{ kind: 'pass', run: CiRun } | { kind: 'wait', reason: string } | { kind: 'fail', reason: string }} CiVerdict
 */

/**
 * Decide from the runs on one commit. `noRunExpired` is whether the grace
 * period for CI to be queued at all has run out.
 * @param {CiRun[]} runs
 * @param {{ noRunExpired: boolean }} opts
 * @returns {CiVerdict}
 */
export function ciVerdict(runs, { noRunExpired }) {
  const passed = runs.find((run) => run.status === 'completed' && run.conclusion === 'success')
  if (passed) return { kind: 'pass', run: passed }
  const pending = runs.filter((run) => run.status !== 'completed')
  if (pending.length > 0) {
    return { kind: 'wait', reason: `${pending.length} CI run(s) still ${pending.map((run) => run.status).join(', ')}` }
  }
  if (runs.length > 0) {
    const list = runs.map((run) => `  ${run.conclusion || 'no conclusion'} (${run.event}) ${run.url}`).join('\n')
    return {
      kind: 'fail',
      reason: `CI did not pass on this commit:\n${list}\nFix or re-run CI on this commit, then re-run this release.`
    }
  }
  if (noRunExpired) {
    return {
      kind: 'fail',
      reason:
        'No CI run exists for this commit. CI runs on pushes to main and on pull requests, so tag a commit that is on main.'
    }
  }
  return { kind: 'wait', reason: 'no CI run queued for this commit yet' }
}

/** @returns {CiRun[]} */
function listRuns(repo, workflow, sha) {
  const out = execFileSync(
    'gh',
    [
      'run',
      'list',
      '--repo',
      repo,
      '--workflow',
      workflow,
      '--commit',
      sha,
      '--limit',
      '50',
      '--json',
      'databaseId,status,conclusion,event,url'
    ],
    { encoding: 'utf8' }
  )
  return JSON.parse(out)
}

function positiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function main() {
  const sha = process.env.GITHUB_SHA
  const repo = process.env.GITHUB_REPOSITORY
  if (!sha || !repo) {
    console.error('GITHUB_SHA and GITHUB_REPOSITORY must be set.')
    process.exit(1)
  }
  const workflow = process.env.CI_WORKFLOW || 'ci.yml'
  const waitMs = positiveNumber(process.env.CI_WAIT_MINUTES, 120) * 60_000
  const noRunMs = positiveNumber(process.env.CI_WAIT_NO_RUN_MINUTES, 15) * 60_000
  const pollMs = positiveNumber(process.env.CI_POLL_SECONDS, 60) * 1000
  const started = Date.now()

  console.log(`Waiting for ${workflow} on ${repo}@${sha}`)
  for (;;) {
    const elapsed = Date.now() - started
    const verdict = ciVerdict(listRuns(repo, workflow, sha), { noRunExpired: elapsed >= noRunMs })
    if (verdict.kind === 'pass') {
      console.log(`CI passed on this commit: ${verdict.run.url}`)
      return
    }
    if (verdict.kind === 'fail') {
      console.error(verdict.reason)
      process.exit(1)
    }
    if (elapsed >= waitMs) {
      console.error(`Gave up after ${Math.round(elapsed / 60_000)} min: ${verdict.reason}.`)
      process.exit(1)
    }
    console.log(`${verdict.reason}; checking again in ${Math.round(pollMs / 1000)}s`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
