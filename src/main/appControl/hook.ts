/**
 * The agent's `app_control` reaches the runner through here: the agent's
 * tools can't import it (it starts runs, which import the agent loop, which
 * imports the tools). Main sets it at startup; unset, the tool says so.
 */
import type { AppActionContext, AppActionResult } from './runner'

type Runner = (name: string, args: unknown, ctx: AppActionContext) => Promise<AppActionResult>

let runner: Runner | null = null

export function setAppActionRunner(next: Runner | null): void {
  runner = next
}

export function appActionRunner(): Runner | null {
  return runner
}
