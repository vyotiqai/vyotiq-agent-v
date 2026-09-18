import { runAgent } from '../loop'
import type { RunRuntime } from './types'

/** In-app execution: the agent loop runs inside the Electron main process. */
export const localRuntime: RunRuntime = {
  kind: 'local',
  start: (input) => runAgent(input)
}
