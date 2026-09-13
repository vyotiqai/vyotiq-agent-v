import { z } from 'zod'

export const SlashCommandKindSchema = z.enum([
  'builtin',
  'skill',
  'workspace',
  'rule',
  'mcp'
])
export type SlashCommandKind = z.infer<typeof SlashCommandKindSchema>

export const SlashCommandAvailabilitySchema = z.enum([
  'ready',
  'disabled',
  'not_installed',
  'needs_auth',
  'disconnected'
])
export type SlashCommandAvailability = z.infer<typeof SlashCommandAvailabilitySchema>

export const SlashCommandDescriptorSchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(''),
  kind: SlashCommandKindSchema,
  group: z.string().min(1),
  availability: SlashCommandAvailabilitySchema,
  packageId: z.string().min(1).optional(),
  mcpServerId: z.string().min(1).optional(),
  mcpToolName: z.string().min(1).optional()
})
export type SlashCommandDescriptor = z.infer<typeof SlashCommandDescriptorSchema>

export const BuiltinClientActionSchema = z.enum([
  'clear',
  'compact',
  'open_marketplace',
  'open_settings',
  'create_rule',
  'create_skill',
  'undo_writes',
  'set_mode_ask',
  'set_mode_plan',
  'set_mode_agent',
  'harness_apply',
  'goal_pause',
  'goal_resume',
  'goal_complete',
  'goal_usage',
  'loop_set',
  'loop_stop',
  'loop_status'
])
export type BuiltinClientAction = z.infer<typeof BuiltinClientActionSchema>

export const SlashCommandResolveResultSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    message: z.string()
  }),
  z.object({
    action: z.literal('client'),
    clientAction: BuiltinClientActionSchema,
    trailingText: z.string().optional(),
    mcpServerId: z.string().min(1).optional()
  }),
  z.object({
    action: z.literal('marketplace'),
    packageId: z.string().min(1),
    intent: z.enum(['install', 'enable'])
  }),
  z.object({
    action: z.literal('open_file'),
    path: z.string().min(1)
  })
])
export type SlashCommandResolveResult = z.infer<typeof SlashCommandResolveResultSchema>

export const SlashCommandsListRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional()
})
export type SlashCommandsListRequest = z.infer<typeof SlashCommandsListRequestSchema>

export const SlashCommandsListResultSchema = z.object({
  commands: z.array(SlashCommandDescriptorSchema)
})
export type SlashCommandsListResult = z.infer<typeof SlashCommandsListResultSchema>

export const SlashCommandsResolveRequestSchema = z.object({
  id: z.string().min(1),
  workspacePath: z.string().min(1).nullable().optional(),
  trailingText: z.string().optional()
})
export type SlashCommandsResolveRequest = z.infer<typeof SlashCommandsResolveRequestSchema>

export const SlashCommandsCreateRuleRequestSchema = z.object({
  workspacePath: z.string().min(1),
  title: z.string().optional()
})
export type SlashCommandsCreateRuleRequest = z.infer<typeof SlashCommandsCreateRuleRequestSchema>

export const SlashCommandsCreateRuleResultSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1)
})
export type SlashCommandsCreateRuleResult = z.infer<typeof SlashCommandsCreateRuleResultSchema>

export const SlashCommandsCreateSkillRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional(),
  title: z.string().optional(),
  scope: z.enum(['project', 'personal']).optional()
})
export type SlashCommandsCreateSkillRequest = z.infer<typeof SlashCommandsCreateSkillRequestSchema>

export const SlashCommandsCreateSkillResultSchema = z.object({
  path: z.string().min(1),
  relativePath: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(['project', 'personal'])
})
export type SlashCommandsCreateSkillResult = z.infer<typeof SlashCommandsCreateSkillResultSchema>

export const LocalSkillOriginSchema = z.enum(['vyotiq', 'cursor'])
export type LocalSkillOrigin = z.infer<typeof LocalSkillOriginSchema>

export const LocalSkillItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  source: z.enum(['project', 'personal']),
  origin: LocalSkillOriginSchema.optional(),
  skillPath: z.string().min(1),
  relativePath: z.string().min(1)
})
export type LocalSkillItem = z.infer<typeof LocalSkillItemSchema>

export const SkillsListLocalRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional()
})
export type SkillsListLocalRequest = z.infer<typeof SkillsListLocalRequestSchema>

export const SkillsListLocalResultSchema = z.object({
  skills: z.array(LocalSkillItemSchema)
})
export type SkillsListLocalResult = z.infer<typeof SkillsListLocalResultSchema>

export const SkillsOpenLocalRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional(),
  skillPath: z.string().min(1)
})
export type SkillsOpenLocalRequest = z.infer<typeof SkillsOpenLocalRequestSchema>

const SKILL_FILE_CONTENT_MAX = 256_000

export const SkillsReadLocalRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional(),
  skillPath: z.string().min(1)
})
export type SkillsReadLocalRequest = z.infer<typeof SkillsReadLocalRequestSchema>

export const SkillsReadLocalResultSchema = z.object({
  skillPath: z.string().min(1),
  content: z.string(),
  name: z.string().min(1),
  description: z.string(),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  allowedTools: z.string().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  body: z.string()
})
export type SkillsReadLocalResult = z.infer<typeof SkillsReadLocalResultSchema>

export const SkillsWriteLocalRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional(),
  skillPath: z.string().min(1),
  content: z.string().min(1).max(SKILL_FILE_CONTENT_MAX)
})
export type SkillsWriteLocalRequest = z.infer<typeof SkillsWriteLocalRequestSchema>

export const SkillsWriteLocalResultSchema = z.object({
  skillPath: z.string().min(1),
  relativePath: z.string().min(1),
  name: z.string().min(1)
})
export type SkillsWriteLocalResult = z.infer<typeof SkillsWriteLocalResultSchema>

export const SkillsDeleteLocalRequestSchema = z.object({
  workspacePath: z.string().min(1).nullable().optional(),
  skillPath: z.string().min(1)
})
export type SkillsDeleteLocalRequest = z.infer<typeof SkillsDeleteLocalRequestSchema>

export const SkillsChangedPayloadSchema = z.object({
  workspacePath: z.string().nullable()
})
export type SkillsChangedPayload = z.infer<typeof SkillsChangedPayloadSchema>

export const SlashCommandsOpenFileRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1)
})
export type SlashCommandsOpenFileRequest = z.infer<typeof SlashCommandsOpenFileRequestSchema>
