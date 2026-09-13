import { parseGoalInvocation } from '../goalRuntime'

/** Rewrite skill-instruction tag opens/closes so a body cannot close the wrap. */
function neutralizeSkillInstructionTags(body: string): string {
  return body.replace(/<\s*\/?\s*skill\s+instructions\b/gi, (match) => match.replace('<', '&lt;'))
}

/** Inject skill body as a strong this-turn instruction plus user trailing text. */
export function formatSkillInvocation(
  skillName: string,
  body: string,
  userText?: string
): string {
  const trailing = (userText ?? '').trim()
  return [
    `[Skill: ${skillName}]`,
    '',
    '<skill instructions>',
    neutralizeSkillInstructionTags(body.trim()),
    '</skill instructions>',
    '',
    'User request:',
    trailing || '(no additional instructions)'
  ].join('\n')
}

export type ParsedSkillInvocation = {
  skillName: string
  body: string
  /** Empty when the template used `(no additional instructions)`. */
  userRequest: string
}

const SKILL_HEADER_RE = /^\[Skill:\s*([^\]]+)\]\s*\n\n<skill instructions>\n/
const SKILL_CLOSER = '\n</skill instructions>\n\nUser request:\n'

/**
 * Parse a message produced by `formatSkillInvocation`.
 * Uses the last closer so skill bodies may document `</skill instructions>` / `User request:`.
 */
export function parseSkillInvocation(text: string): ParsedSkillInvocation | null {
  const raw = text.trim()
  const header = SKILL_HEADER_RE.exec(raw)
  if (!header) return null
  const skillName = (header[1] ?? '').trim()
  if (!skillName) return null
  const afterOpen = raw.slice(header[0].length)
  const closeIdx = afterOpen.lastIndexOf(SKILL_CLOSER)
  if (closeIdx < 0) return null
  const body = afterOpen.slice(0, closeIdx).trim()
  const rawRequest = afterOpen.slice(closeIdx + SKILL_CLOSER.length).trim()
  const userRequest =
    rawRequest === '(no additional instructions)' ? '' : rawRequest
  return { skillName, body, userRequest }
}

/** Marker body stored after the invoking turn so durable history does not keep the full skill. */
export const SKILL_BODY_STUB =
  '(Skill instructions were applied on an earlier turn; full body omitted to save tokens.)'

export function isSkillInvocationBodyStubbed(body: string): boolean {
  return body.trim() === SKILL_BODY_STUB
}

/**
 * Replace a full skill-invocation body with {@link SKILL_BODY_STUB}, keeping name + user request.
 * Returns null when the text is not a skill invocation or is already stubbed.
 */
export function stubSkillInvocationContent(text: string): string | null {
  const parsed = parseSkillInvocation(text)
  if (!parsed) return null
  if (isSkillInvocationBodyStubbed(parsed.body)) return null
  return formatSkillInvocation(parsed.skillName, SKILL_BODY_STUB, parsed.userRequest)
}

function isSkillToolResultMessage(m: { role: string; toolName?: string }): boolean {
  return m.role === 'tool' && m.toolName === 'Skill'
}

function isSkillToolResultStubbed(content: unknown): boolean {
  return typeof content === 'string' && content.trim() === SKILL_BODY_STUB
}

/**
 * Stub skill bodies on user turns that already have follow-up messages so later
 * assemble / durable history do not resend the full skill text every step.
 * The latest message (open skill turn) keeps the full body for the current model call.
 * Earlier Skill **tool** results are stubbed the same way; the latest Skill tool
 * result stays intact for the current step.
 */
export function stubPastSkillInvocationsInMessages<
  T extends { role: string; content: unknown; toolName?: string }
>(messages: T[]): { messages: T[]; stubbedCount: number } {
  let stubbedCount = 0
  const afterSlash = messages.map((m, i) => {
    if (m.role !== 'user' || typeof m.content !== 'string') return m
    if (i >= messages.length - 1) return m
    const stubbed = stubSkillInvocationContent(m.content)
    if (!stubbed) return m
    stubbedCount += 1
    return { ...m, content: stubbed }
  })
  let lastSkillToolIdx = -1
  for (let i = afterSlash.length - 1; i >= 0; i--) {
    const msg = afterSlash[i]
    if (msg && isSkillToolResultMessage(msg)) {
      lastSkillToolIdx = i
      break
    }
  }
  if (lastSkillToolIdx < 0) {
    return { messages: afterSlash, stubbedCount }
  }
  const out = afterSlash.map((m, i) => {
    if (!isSkillToolResultMessage(m) || i === lastSkillToolIdx) return m
    if (isSkillToolResultStubbed(m.content)) return m
    stubbedCount += 1
    return { ...m, content: SKILL_BODY_STUB }
  })
  return { messages: out, stubbedCount }
}

/** Compact timeline / queue preview — skill name + user request, no body. */
export function skillInvocationDisplayText(parsed: ParsedSkillInvocation): string {
  const nameLine = `/${parsed.skillName}`
  if (!parsed.userRequest) return nameLine
  return `${nameLine}\n\n${parsed.userRequest}`
}

/** Edit-composer draft that re-resolves via slash submit on send. */
export function skillInvocationEditDraft(parsed: ParsedSkillInvocation): string {
  if (!parsed.userRequest) return `/${parsed.skillName}`
  return `/${parsed.skillName} ${parsed.userRequest}`
}

/** Cursor-compatible `{{input}}` replacement in workspace command templates. */
export function formatWorkspaceCommand(template: string, userText?: string): string {
  const input = (userText ?? '').trim()
  if (template.includes('{{input}}')) {
    return template.split('{{input}}').join(input)
  }
  if (!input) return template.trim()
  return `${template.trim()}\n\n${input}`
}

/** Agent-mediated MCP tool hint (structured args are out of scope for slash v1). */
export function formatMcpToolInvocation(
  serverId: string,
  toolName: string,
  description: string,
  userText?: string
): string {
  const trailing = (userText ?? '').trim()
  return [
    `Use the MCP tool \`${toolName}\` from server \`${serverId}\`.`,
    description ? `Tool description: ${description}` : null,
    '',
    'Goal / arguments hint:',
    trailing || '(infer reasonable arguments from context)'
  ]
    .filter((line): line is string => line != null)
    .join('\n')
}

export type ParsedMcpToolInvocation = {
  serverId: string
  toolName: string
  /** Empty when the template used the infer-placeholder. */
  userRequest: string
}

const MCP_HEADER_RE = /^Use the MCP tool `([^`]+)` from server `([^`]+)`\.\n/
const MCP_GOAL_MARKER = '\nGoal / arguments hint:\n'

/**
 * Parse a message produced by `formatMcpToolInvocation`.
 * Uses the last goal marker so tool descriptions may be multi-line.
 */
export function parseMcpToolInvocation(text: string): ParsedMcpToolInvocation | null {
  const raw = text.trim()
  const header = MCP_HEADER_RE.exec(raw)
  if (!header) return null
  const toolName = (header[1] ?? '').trim()
  const serverId = (header[2] ?? '').trim()
  if (!toolName || !serverId) return null
  const afterHeader = raw.slice(header[0].length)
  const goalIdx = afterHeader.lastIndexOf(MCP_GOAL_MARKER)
  if (goalIdx < 0) return null
  // Optional `Tool description: …` (may span lines) sits before the goal marker.
  const rawRequest = afterHeader.slice(goalIdx + MCP_GOAL_MARKER.length).trim()
  const userRequest =
    rawRequest === '(infer reasonable arguments from context)' ? '' : rawRequest
  return { serverId, toolName, userRequest }
}

/** Compact timeline / queue preview for MCP slash sends. */
export function mcpInvocationDisplayText(parsed: ParsedMcpToolInvocation): string {
  const nameLine = `/${parsed.serverId}-${parsed.toolName}`
  if (!parsed.userRequest) return nameLine
  return `${nameLine}\n\n${parsed.userRequest}`
}

export type SlashChipInfo =
  | { kind: 'skill'; name: string; userRequest: string }
  | { kind: 'mcp'; name: string; userRequest: string }

/** Sidebar / user-prompt chip from stored message content. */
export function slashChipFromContent(content: string): SlashChipInfo | null {
  const skill = parseSkillInvocation(content)
  if (skill) {
    return { kind: 'skill', name: skill.skillName, userRequest: skill.userRequest }
  }
  const mcp = parseMcpToolInvocation(content)
  if (mcp) {
    return {
      kind: 'mcp',
      name: `${mcp.serverId}-${mcp.toolName}`,
      userRequest: mcp.userRequest
    }
  }
  return null
}

/** Display text for any user message; skill/MCP injections collapse to a summary. */
export function userMessageDisplayText(text: string): string {
  const skill = parseSkillInvocation(text)
  if (skill) return skillInvocationDisplayText(skill)
  const mcp = parseMcpToolInvocation(text)
  if (mcp) return mcpInvocationDisplayText(mcp)
  return text
}

const WINDOWS_ABS_PATH =
  /(?:^|[\s"'`])([A-Za-z]:\\(?:[^<>:"/|?*\r\n]+\\)*[^<>:"/|?*\r\n]+)(?=$|[\s"'`])/g
const UNIX_ABS_PATH =
  /(?:^|[\s"'`])(\/(?:Users|home|tmp|var|opt|mnt|Volumes)\/[^\s"'`]+)(?=$|[\s"'`])/g

/** Absolute paths mentioned in user text (Windows drive / common Unix roots). */
export function findAbsolutePathsInText(text: string): string[] {
  const found = new Set<string>()
  for (const re of [WINDOWS_ABS_PATH, UNIX_ABS_PATH]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const p = (m[1] ?? '').replace(/[\\/]+$/, '').trim()
      if (p) found.add(p)
    }
  }
  return [...found]
}

/** Strip absolute paths from a goal line; empty after scrub → `'chat'`. */
export function scrubPathsFromGoalText(text: string): string {
  const paths = findAbsolutePathsInText(text)
  let out = text
  for (const p of paths) {
    out = out.split(p).join(' ')
  }
  out = out
    .replace(/["'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return out || 'chat'
}

/**
 * Goal/contract line for a new run. Never stores raw `<skill instructions>` bodies
 * even when parse fails (truncated / legacy formatting).
 */
export function runGoalFromUserText(text: string): string {
  const collapsed = userMessageDisplayText(text).trim()
  const goalInvoke = parseGoalInvocation(collapsed)
  if (goalInvoke) {
    return scrubPathsFromGoalText(goalInvoke.objective).slice(0, 200)
  }
  let goal: string
  if (collapsed && !/<skill instructions>/i.test(collapsed)) {
    goal = collapsed
  } else {
    const skillHeader = /^\[Skill:\s*([^\]]+)\]/i.exec(text.trim())
    if (skillHeader?.[1]?.trim()) {
      const name = skillHeader[1].trim()
      const reqIdx = text.lastIndexOf('User request:')
      const rawReq =
        reqIdx >= 0 ? text.slice(reqIdx + 'User request:'.length).trim() : ''
      const userRequest =
        !rawReq || rawReq === '(no additional instructions)' ? '' : rawReq
      goal = userRequest ? `/${name}\n\n${userRequest}` : `/${name}`
    } else {
      // Strip skill instruction blocks if they leaked into an otherwise plain message.
      const stripped = text
        .replace(/<skill instructions>[\s\S]*?<\/skill instructions>/gi, '')
        .replace(/^\[Skill:\s*[^\]]+\]\s*/i, '')
        .replace(/^User request:\s*/im, '')
        .replace(/\(no additional instructions\)/gi, '')
        .trim()
      goal = stripped || collapsed || 'chat'
    }
  }
  return scrubPathsFromGoalText(goal).slice(0, 200)
}

/** Guidance when the user points at files outside the workspace sandbox. */
export function outsideWorkspacePathGuidance(paths: string[]): string {
  if (paths.length === 0) return ''
  const list = paths
    .slice(0, 5)
    .map((p) => `- ${p}`)
    .join('\n')
  return [
    'The user message references absolute path(s) outside the workspace sandbox:',
    list,
    'read/edit tools cannot open those paths. Copy or move the file(s) into the workspace, or ask the user to attach/@-mention an in-workspace path. Prefer terminal only if the user explicitly wants shell access to that location.'
  ].join('\n')
}
