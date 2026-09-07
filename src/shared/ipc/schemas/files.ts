import { z } from 'zod'
import { isSafeWorkspaceRelPath } from '../../utils/workspacePath'

export const WORKSPACE_FILE_TEXT_MAX_BYTES = 8 * 1024 * 1024
export const WORKSPACE_FILE_BINARY_MAX_BYTES = 16 * 1024 * 1024
export const WORKSPACE_FILE_LIST_PAGE_MAX = 200
export const WORKSPACE_EDITOR_RECOVERY_MAX_TABS = 32
export const WORKSPACE_EDITOR_RECOVERY_MAX_SELECTIONS = 256
export const WORKSPACE_EDITOR_RECOVERY_MAX_BOOKMARKS = 256
export const WORKSPACE_EDITOR_RECOVERY_MAX_EXPANDED_PATHS = 1_024
export const WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES = 48 * 1024 * 1024

export const WorkspacePathSchema = z.string().min(1)

export const WorkspaceFileKindSchema = z.enum(['file', 'directory', 'symlink', 'other'])
export type WorkspaceFileKind = z.infer<typeof WorkspaceFileKindSchema>

export const WorkspaceFileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: WorkspaceFileKindSchema,
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative().nullable(),
  hidden: z.boolean(),
  symlinkTargetInsideWorkspace: z.boolean().nullable()
})
export type WorkspaceFileEntry = z.infer<typeof WorkspaceFileEntrySchema>

export const WorkspaceFileListRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: z.string().default(''),
  offset: z.number().int().nonnegative().max(10_000_000).default(0),
  limit: z.number().int().min(1).max(WORKSPACE_FILE_LIST_PAGE_MAX).default(200)
})
export type WorkspaceFileListRequest = z.infer<typeof WorkspaceFileListRequestSchema>

export const WorkspaceFileListResultSchema = z.object({
  path: z.string(),
  entries: z.array(WorkspaceFileEntrySchema),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean()
})
export type WorkspaceFileListResult = z.infer<typeof WorkspaceFileListResultSchema>

export const WorkspaceFileEncodingSchema = z.enum(['utf8', 'utf16le', 'utf16be', 'binary'])
export type WorkspaceFileEncoding = z.infer<typeof WorkspaceFileEncodingSchema>

export const WorkspaceFileEolSchema = z.enum(['lf', 'crlf', 'cr', 'mixed', 'none'])
export type WorkspaceFileEol = z.infer<typeof WorkspaceFileEolSchema>

export const WorkspaceFileVersionSchema = z.object({
  size: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
export type WorkspaceFileVersion = z.infer<typeof WorkspaceFileVersionSchema>

export const WorkspaceFileReadRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema
})
export type WorkspaceFileReadRequest = z.infer<typeof WorkspaceFileReadRequestSchema>

export const WorkspaceFileReadResultSchema = z.object({
  path: WorkspacePathSchema,
  kind: z.enum(['text', 'binary']),
  content: z.string(),
  encoding: WorkspaceFileEncodingSchema,
  eol: WorkspaceFileEolSchema,
  bom: z.boolean(),
  size: z.number().int().nonnegative(),
  version: WorkspaceFileVersionSchema,
  truncated: z.boolean()
})
export type WorkspaceFileReadResult = z.infer<typeof WorkspaceFileReadResultSchema>

export const WorkspaceFileStatRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema
})
export type WorkspaceFileStatRequest = z.infer<typeof WorkspaceFileStatRequestSchema>

/** Cheap change probe for open editor tabs — stat only, never reads file content. */
export const WorkspaceFileStatResultSchema = z.object({
  path: WorkspacePathSchema,
  exists: z.boolean(),
  size: z.number().int().nonnegative(),
  mtimeMs: z.number()
})
export type WorkspaceFileStatResult = z.infer<typeof WorkspaceFileStatResultSchema>

export const WorkspaceReadImageRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema
})
export type WorkspaceReadImageRequest = z.infer<typeof WorkspaceReadImageRequestSchema>

export const WorkspaceReadImageResultSchema = z.object({
  mime: z.string().min(1),
  /** `data:<mime>;base64,...` for direct use in an <img> src. */
  dataUrl: z.string().min(1)
})
export type WorkspaceReadImageResult = z.infer<typeof WorkspaceReadImageResultSchema>

export const WorkspaceFileSaveRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema,
  kind: z.enum(['text', 'binary']),
  content: z.string(),
  encoding: WorkspaceFileEncodingSchema,
  eol: WorkspaceFileEolSchema,
  bom: z.boolean().default(false),
  expectedVersion: WorkspaceFileVersionSchema.nullable(),
  replaceExisting: z.boolean().default(false)
})
export type WorkspaceFileSaveRequest = z.infer<typeof WorkspaceFileSaveRequestSchema>

export const WorkspaceFileSaveResultSchema = z.object({
  path: WorkspacePathSchema,
  version: WorkspaceFileVersionSchema,
  size: z.number().int().nonnegative()
})
export type WorkspaceFileSaveResult = z.infer<typeof WorkspaceFileSaveResultSchema>

export const WorkspaceFileCreateRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  parentPath: z.string().default(''),
  name: z.string().min(1).max(255),
  kind: z.enum(['file', 'directory']),
  replaceExisting: z.boolean().default(false)
})
export type WorkspaceFileCreateRequest = z.infer<typeof WorkspaceFileCreateRequestSchema>

export const WorkspaceFileCreateResultSchema = z.object({
  entry: WorkspaceFileEntrySchema
})
export type WorkspaceFileCreateResult = z.infer<typeof WorkspaceFileCreateResultSchema>

export const WorkspaceFileMoveRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  fromPath: WorkspacePathSchema,
  toPath: WorkspacePathSchema,
  replaceExisting: z.boolean().default(false)
})
export type WorkspaceFileMoveRequest = z.infer<typeof WorkspaceFileMoveRequestSchema>

export const WorkspaceFileMoveResultSchema = z.object({
  entry: WorkspaceFileEntrySchema
})
export type WorkspaceFileMoveResult = z.infer<typeof WorkspaceFileMoveResultSchema>

export const WorkspaceFileDeleteRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema,
  recursive: z.boolean().default(false)
})
export type WorkspaceFileDeleteRequest = z.infer<typeof WorkspaceFileDeleteRequestSchema>

export const WorkspaceFileDeleteResultSchema = z.object({
  path: WorkspacePathSchema,
  kind: WorkspaceFileKindSchema
})
export type WorkspaceFileDeleteResult = z.infer<typeof WorkspaceFileDeleteResultSchema>

export const WorkspaceFileRevealRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema
})
export type WorkspaceFileRevealRequest = z.infer<typeof WorkspaceFileRevealRequestSchema>

export const WorkspaceFormatterStatusRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema
})
export type WorkspaceFormatterStatusRequest = z.infer<
  typeof WorkspaceFormatterStatusRequestSchema
>

export const WorkspaceFormatterStatusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('available'),
    tool: z.string().min(1).max(256)
  }),
  z.object({
    kind: z.literal('unavailable'),
    detail: z.string().min(1).max(512)
  })
])
export type WorkspaceFormatterStatus = z.infer<typeof WorkspaceFormatterStatusSchema>

export const WorkspaceFormatFileRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema,
  content: z.string()
})
export type WorkspaceFormatFileRequest = z.infer<typeof WorkspaceFormatFileRequestSchema>

export const WorkspaceFormatFileResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('formatted'),
    content: z.string(),
    tool: z.string().min(1).max(256)
  }),
  z.object({
    kind: z.literal('unchanged'),
    content: z.string(),
    tool: z.string().min(1).max(256)
  }),
  z.object({
    kind: z.literal('unavailable'),
    detail: z.string().min(1).max(512)
  })
])
export type WorkspaceFormatFileResult = z.infer<typeof WorkspaceFormatFileResultSchema>

export const WorkspaceLspCapabilitySchema = z.enum([
  'hover',
  'completion',
  'diagnostics',
  'definition',
  'rename'
])
export type WorkspaceLspCapability = z.infer<typeof WorkspaceLspCapabilitySchema>

export const WorkspaceLspStatusRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema
})
export type WorkspaceLspStatusRequest = z.infer<typeof WorkspaceLspStatusRequestSchema>

export const WorkspaceLspServerSchema = z.object({
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(128),
  command: z.string().min(1).max(1_024),
  source: z.enum(['workspace', 'path']),
  capabilities: z.array(WorkspaceLspCapabilitySchema).max(5)
})
export type WorkspaceLspServer = z.infer<typeof WorkspaceLspServerSchema>

export const WorkspaceLspStatusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('available'),
    server: WorkspaceLspServerSchema
  }),
  z.object({
    kind: z.literal('unavailable'),
    detail: z.string().min(1).max(512)
  })
])
export type WorkspaceLspStatus = z.infer<typeof WorkspaceLspStatusSchema>

export const WorkspaceLspRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: WorkspacePathSchema,
  content: z.string(),
  action: z.enum(['hover', 'completion', 'diagnostics', 'definition', 'rename']),
  newName: z.string().trim().min(1).max(256).optional(),
  line: z.number().int().nonnegative().max(1_000_000).default(0),
  character: z.number().int().nonnegative().max(1_000_000).default(0)
})
export type WorkspaceLspRequest = z.infer<typeof WorkspaceLspRequestSchema>

const WorkspaceLspDiagnosticSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
  message: z.string().max(4_096),
  severity: z.enum(['error', 'warning', 'info', 'hint'])
})

export const WorkspaceLspResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hover'),
    content: z.string().max(16_384).nullable()
  }),
  z.object({
    kind: z.literal('completion'),
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(512),
          detail: z.string().max(1_024).nullable()
        })
      )
      .max(200)
  }),
  z.object({
    kind: z.literal('diagnostics'),
    items: z.array(WorkspaceLspDiagnosticSchema).max(1_000)
  }),
  z.object({
    kind: z.literal('definition'),
    path: z.string().max(4_096).nullable(),
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal('rename'),
    edits: z
      .array(
        z.object({
          path: z.string().min(1).max(4_096),
          startLine: z.number().int().nonnegative(),
          startCharacter: z.number().int().nonnegative(),
          endLine: z.number().int().nonnegative(),
          endCharacter: z.number().int().nonnegative(),
          newText: z.string()
        })
      )
      .max(200)
  })
])
export type WorkspaceLspResponse = z.infer<typeof WorkspaceLspResponseSchema>

export const WorkspaceEditorSelectionSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative()
})
export type WorkspaceEditorSelection = z.infer<typeof WorkspaceEditorSelectionSchema>

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export const WorkspaceEditorTabSnapshotSchema = z
  .object({
  id: z.string().min(1).max(256),
  path: WorkspacePathSchema,
  kind: z.enum(['text', 'binary']),
  content: z.string(),
  encoding: WorkspaceFileEncodingSchema,
  eol: WorkspaceFileEolSchema,
  bom: z.boolean(),
  version: WorkspaceFileVersionSchema.nullable(),
  dirty: z.boolean(),
  cursor: z.number().int().nonnegative(),
  selections: z.array(WorkspaceEditorSelectionSchema).max(WORKSPACE_EDITOR_RECOVERY_MAX_SELECTIONS),
  bookmarks: z.array(z.number().int().nonnegative()).max(WORKSPACE_EDITOR_RECOVERY_MAX_BOOKMARKS),
  template: z.string().max(256).nullable(),
  scrollTop: z.number().int().nonnegative().max(10_000_000).optional()
  })
  .superRefine((tab, ctx) => {
    if (!isSafeWorkspaceRelPath(tab.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: 'Recovery path must be a safe workspace-relative path'
      })
    }
    if (tab.kind === 'binary' && tab.encoding !== 'binary') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encoding'],
        message: 'Binary recovery tabs must use binary encoding'
      })
    }
    if (tab.kind === 'text' && tab.encoding === 'binary') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encoding'],
        message: 'Text recovery tabs cannot use binary encoding'
      })
    }
    if (tab.kind === 'binary' && !BASE64_PATTERN.test(tab.content)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'Binary recovery content must be valid base64'
      })
    }
    for (const [index, selection] of tab.selections.entries()) {
      if (selection.from > selection.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selections', index],
          message: 'Selection start must not exceed selection end'
        })
      }
    }
  })
export type WorkspaceEditorTabSnapshot = z.infer<typeof WorkspaceEditorTabSnapshotSchema>

export const WorkspaceEditorRecoverySnapshotSchema = z.object({
  version: z.literal(1),
  activeTabId: z.string().max(256).nullable(),
  selectedPath: z.string().max(32_768).nullable().optional(),
  expandedPaths: z
    .array(z.string().max(32_768))
    .max(WORKSPACE_EDITOR_RECOVERY_MAX_EXPANDED_PATHS)
    .optional(),
  treeSort: z.enum(['name', 'kind']).optional(),
  showLineNumbers: z.boolean().optional(),
  wordWrap: z.boolean().optional(),
  autoSave: z.boolean().optional(),
  formatOnSave: z.boolean().optional(),
  showIgnoredFiles: z.boolean().optional(),
  tabs: z.array(WorkspaceEditorTabSnapshotSchema).max(WORKSPACE_EDITOR_RECOVERY_MAX_TABS),
  savedAt: z.string().datetime()
}).superRefine((snapshot, ctx) => {
  const encoder = new TextEncoder()
  let contentBytes = 0
  for (const [index, tab] of snapshot.tabs.entries()) {
    contentBytes += encoder.encode(tab.content).byteLength
    if (contentBytes > WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        path: ['tabs', index, 'content'],
        maximum: WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES,
        type: 'string',
        inclusive: true,
        message: 'Editor recovery content is too large'
      })
      break
    }
  }
})
export type WorkspaceEditorRecoverySnapshot = z.infer<
  typeof WorkspaceEditorRecoverySnapshotSchema
>

export const WorkspaceEditorRecoverySaveRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  sessionToken: z.string().min(16).max(128),
  generation: z.number().int().nonnegative(),
  snapshot: WorkspaceEditorRecoverySnapshotSchema
})
export type WorkspaceEditorRecoverySaveRequest = z.infer<
  typeof WorkspaceEditorRecoverySaveRequestSchema
>

export const WorkspaceEditorRecoveryLoadRequestSchema = z.object({
  workspacePath: WorkspacePathSchema
})
export type WorkspaceEditorRecoveryLoadRequest = z.infer<
  typeof WorkspaceEditorRecoveryLoadRequestSchema
>

export const WorkspaceEditorRecoveryLoadResultSchema = z.object({
  snapshot: WorkspaceEditorRecoverySnapshotSchema.nullable(),
  source: z.enum(['app', 'project', 'none']),
  sessionToken: z.string().min(16).max(128),
  generation: z.number().int().nonnegative()
})
export type WorkspaceEditorRecoveryLoadResult = z.infer<
  typeof WorkspaceEditorRecoveryLoadResultSchema
>

export const WorkspaceEditorRecoveryClearRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  sessionToken: z.string().min(16).max(128),
  generation: z.number().int().nonnegative()
})
export type WorkspaceEditorRecoveryClearRequest = z.infer<
  typeof WorkspaceEditorRecoveryClearRequestSchema
>

export const INLINE_COMPLETE_PREFIX_MAX = 8_000
export const INLINE_COMPLETE_SUFFIX_MAX = 4_000

export const INLINE_COMPLETE_REQUEST_ID = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

export const WorkspaceInlineCompleteRequestSchema = z.object({
  workspacePath: WorkspacePathSchema,
  path: z
    .string()
    .min(1)
    .max(4_096)
    .refine(isSafeWorkspaceRelPath, 'Path must stay inside the workspace'),
  prefix: z.string().max(INLINE_COMPLETE_PREFIX_MAX),
  suffix: z.string().max(INLINE_COMPLETE_SUFFIX_MAX),
  requestId: INLINE_COMPLETE_REQUEST_ID.optional()
})
export type WorkspaceInlineCompleteRequest = z.infer<typeof WorkspaceInlineCompleteRequestSchema>

export const WorkspaceInlineCompleteAbortRequestSchema = z.object({
  requestId: INLINE_COMPLETE_REQUEST_ID
})
export type WorkspaceInlineCompleteAbortRequest = z.infer<
  typeof WorkspaceInlineCompleteAbortRequestSchema
>

export const WorkspaceInlineCompleteResultSchema = z.object({
  text: z.string().max(500)
})
export type WorkspaceInlineCompleteResult = z.infer<typeof WorkspaceInlineCompleteResultSchema>
