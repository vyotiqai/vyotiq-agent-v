import type { ViewBlock, ViewBlockOf, ViewSpec } from '../../../shared/viewSpec'
import { branchBlock, changesBlock, checksBlock, commitsBlock, daysBlock, spendBlock, taskChangesBlock } from '../../../shared/viewLiveBlocks'
import { viewBlockLines } from '../../../shared/viewText'
import { readGitStatusCached } from '../../git/gitStatusCache'
import { readGitLog } from '../../git/git'
import { prView } from '../../git/gh'
import { resolveRunDir } from '../../storage/paths'
import { collectHomeActivity } from '../activityStats'
import { taskFileStats } from '../taskFileDiff'

/*
  What a show_view call's live blocks show, told back to the model. The app
  fills a live block from its own read, which the model never sees; without
  this, the words it writes next could say "3 files changed" beside a block
  showing none, or talk about a pull request the block says does not exist.
  Each source is read here the way the record reads it, built by the same
  shared builder, and said as the same lines Copy would give.
*/

type Live = ViewBlockOf<'live'>

/** A read past this is left out: the view still draws, the model just isn't told. */
const READ_MS = 6_000
/** The whole account, so a long change list can't crowd the model's context. */
const MAX_CHARS = 2_000
const MAX_LINES_PER_BLOCK = 14

class Unread extends Error {}

const note = (text: string): ViewBlock => ({ type: 'note', text })

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Unread('took too long to read')), ms)
    work.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

async function readBlock(live: Live, workspace: string, runId: string | undefined): Promise<ViewBlock> {
  switch (live.source) {
    case 'git.changes':
    case 'git.branch': {
      const res = await readGitStatusCached(workspace)
      if (res.kind === 'not_repo') return note('This workspace is not a git repository')
      if (res.kind !== 'ok') return note('Git is not available')
      return live.source === 'git.changes' ? changesBlock(res.status, live) : branchBlock(res.status)
    }
    case 'git.commits':
      return commitsBlock(await readGitLog(workspace, Math.min(live.limit ?? 8, 40)), live)
    case 'pr.checks': {
      const pr = await prView(workspace)
      return pr ? checksBlock(pr, live) : note('No pull request for this branch')
    }
    case 'task.changes':
      if (!runId) return note('Only a task has changes of its own')
      return taskChangesBlock(await taskFileStats(resolveRunDir(workspace, runId), workspace), live)
    case 'usage.spend':
    case 'usage.days': {
      const activity = await collectHomeActivity([workspace], new Date(), 30)
      return live.source === 'usage.spend' ? spendBlock(activity) : daysBlock(activity, live)
    }
  }
}

/** The first line of why a read failed, as the record says it. */
function why(err: unknown): string {
  const first = (err instanceof Error ? err.message : String(err)).split(/\r?\n/).find((l) => l.trim())?.trim() ?? 'could not read it'
  return /no git remotes? found|no default remote/i.test(first) ? 'this workspace has no git remote, so no pull request' : first
}

/**
 * One line per live block in `spec`, saying what the user sees in it now;
 * empty when there are none. Never throws: a read that fails says so.
 */
export async function describeLiveBlocks(spec: ViewSpec, workspace: string, runId: string | undefined): Promise<string> {
  const lives = spec.blocks.filter((b): b is Live => b.type === 'live')
  if (lives.length === 0) return ''
  const said = await Promise.all(
    lives.map(async (live) => {
      const name = live.title ? `${live.source} ("${live.title}")` : live.source
      try {
        const block = await within(READ_MS, readBlock(live, workspace, runId))
        const lines = viewBlockLines(block)
        const shown = lines.slice(0, MAX_LINES_PER_BLOCK)
        if (lines.length > shown.length) shown.push(`- … ${lines.length - shown.length} more lines`)
        return `${name}:\n${shown.join('\n')}`
      } catch (err) {
        return `${name}: not read here (${why(err)}); the user's view reads it itself`
      }
    })
  )
  const text = said.join('\n')
  const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text
  return `What its live blocks show the user now — write about these, not figures from earlier in the run:\n${body}`
}
