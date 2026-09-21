import { z } from 'zod'
import { AgentProfileIdSchema } from './agentProfile'

/**
 * A teammate's private memory namespace, read and written from the Teammates
 * pane.
 *
 * The namespace at `<workspace>/.vyotiq/agents/<profileId>/memory/` is the
 * feature's headline claim and had no surface at all: it could not be read,
 * edited or cleared from inside the app, yet deleting a teammate deliberately
 * preserves it. These channels are that surface.
 *
 * Layout is fixed and shared with the agent's own memory tools —
 * `index.md`, `state.md`, `notes/<name>.md`. Paths are validated in main by
 * `normalizeMemoryRelPath`, the same function the tools use, so the panel and
 * the agent can never disagree about which paths exist.
 */

const WorkspaceAndProfileSchema = z.object({
  workspacePath: z.string().min(1),
  profileId: AgentProfileIdSchema
})

export const AgentMemoryListRequestSchema = WorkspaceAndProfileSchema.strict()
export type AgentMemoryListRequest = z.infer<typeof AgentMemoryListRequestSchema>

/**
 * What the namespace holds. `indexedNotes` are the notes `index.md` actually
 * points at: the index is the map the agent retrieves through, so a note
 * missing from it is invisible to the teammate even though it is on disk.
 * Surfacing both is what lets the panel show that drift.
 */
export const AgentMemoryListResultSchema = z.object({
  workspacePath: z.string().min(1),
  profileId: AgentProfileIdSchema,
  notes: z.array(z.string()),
  indexedNotes: z.array(z.string()),
  hasState: z.boolean(),
  /** False when the namespace directory does not exist yet — never written to. */
  exists: z.boolean()
})
export type AgentMemoryListResult = z.infer<typeof AgentMemoryListResultSchema>

export const AgentMemoryReadRequestSchema = WorkspaceAndProfileSchema.extend({
  /** `index.md`, `state.md`, or `notes/<name>.md`. */
  path: z.string().min(1).max(200)
}).strict()
export type AgentMemoryReadRequest = z.infer<typeof AgentMemoryReadRequestSchema>

export const AgentMemoryReadResultSchema = z.object({
  path: z.string().min(1),
  contents: z.string()
})
export type AgentMemoryReadResult = z.infer<typeof AgentMemoryReadResultSchema>

/**
 * Write one file, or clear the whole namespace.
 *
 * `path: null` is the clear, mirroring `agentProfileOverrideSet`'s
 * `override: null` rather than inventing a second channel for a destructive
 * variant of the same verb. Clearing removes the namespace directory; it is
 * the only way the app deletes a teammate's memory, and deleting the teammate
 * itself still does not.
 */
export const AgentMemoryWriteRequestSchema = WorkspaceAndProfileSchema.extend({
  path: z.string().min(1).max(200).nullable(),
  contents: z.string().max(1_000_000).optional()
})
  .strict()
  .superRefine((req, ctx) => {
    if (req.path !== null && req.contents === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contents'],
        message: 'contents is required unless path is null (clear)'
      })
    }
  })
export type AgentMemoryWriteRequest = z.infer<typeof AgentMemoryWriteRequestSchema>
