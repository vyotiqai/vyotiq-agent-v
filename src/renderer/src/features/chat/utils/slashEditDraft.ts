import { MCP_TOOL_PREFIX } from '@shared/utils/toolSummary'
import { parseMcpToolInvocation, parseSkillInvocation } from '@shared/slashCommands'
import { mentionMarker } from '../components/composer/mentionModel'

/** Rebuild composer edit draft from persisted user message text. */
export function userMessageEditDraft(rawText: string): string {
  const skill = parseSkillInvocation(rawText)
  if (skill) {
    return `${mentionMarker({
      kind: 'slash',
      slashKind: 'skill',
      trigger: skill.skillName
    })}${skill.userRequest ? ` ${skill.userRequest}` : ' '}`
  }
  const mcp = parseMcpToolInvocation(rawText)
  if (mcp) {
    const trigger = `${mcp.serverId}-${mcp.toolName}`.replace(/__/g, '-')
    return `${mentionMarker({
      kind: 'slash',
      slashKind: 'mcp',
      trigger,
      commandId: `mcp:${MCP_TOOL_PREFIX}${mcp.serverId}__${mcp.toolName}`
    })}${mcp.userRequest ? ` ${mcp.userRequest}` : ' '}`
  }
  return rawText
}
