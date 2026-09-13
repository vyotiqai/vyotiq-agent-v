import { AgentEventSchema, type AgentEvent } from '../ipc'

export { formatDisplayTime } from './timeFormat'

export function isAgentEvent(value: unknown): value is AgentEvent {
  return AgentEventSchema.safeParse(value).success
}
