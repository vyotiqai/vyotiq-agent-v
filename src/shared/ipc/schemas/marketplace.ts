import { z } from 'zod'
import { isSafeWorkspaceRelPath } from '../../utils/workspacePath'
import { isAllowedMarketplaceIconUrl } from '../../utils/marketplaceIconUrl'

export const MarketplaceKindSchema = z.enum(['mcp', 'skill', 'plugin'])
export type MarketplaceKind = z.infer<typeof MarketplaceKindSchema>

/** Safe single path segment for marketplace id / version (no traversal). */
export const MarketplaceSegmentSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    message: 'must be a safe path segment (letters, digits, . _ -)'
  })
  .refine((id) => !id.includes('__'), { message: 'must not contain "__"' })

/** Relative path under a package root — aligned with isSafeWorkspaceRelPath. */
export const MarketplaceRelPathSchema = z
  .string()
  .min(1)
  .refine((p) => isSafeWorkspaceRelPath(p), {
    message: 'must be a relative path without ..'
  })

export const MarketplaceInstallSourceSchema = z.enum([
  'registry',
  'path',
  'zip',
  'git',
  'npm',
  'bundled',
  /** Install HTTP/SSE MCP by endpoint URL (materializes a marketplace package). */
  'remote'
])
export type MarketplaceInstallSource = z.infer<typeof MarketplaceInstallSourceSchema>

export const McpTransportSchema = z.enum(['stdio', 'http', 'sse'])
export type McpTransport = z.infer<typeof McpTransportSchema>

/**
 * How a package expects to authenticate, which is what drives the Connect
 * affordance in the UI.
 * - `none`: connects on install (public endpoint or purely local stdio).
 * - `oauth`: browser sign-in with nothing to configure, because the server
 *   advertises RFC 7591 dynamic client registration.
 * - `oauth-client`: browser sign-in, but the server has no registration
 *   endpoint, so the user must register an OAuth app with that vendor and
 *   supply its client id and secret first (Slack and HubSpot both work this
 *   way — they advertise only `client_secret_post`).
 * - `token`: a credential the user pastes, described by `inputs`.
 */
export const McpAuthKindSchema = z.enum(['none', 'oauth', 'oauth-client', 'token'])
export type McpAuthKind = z.infer<typeof McpAuthKindSchema>

/** External binaries a stdio package needs on PATH before it can be spawned. */
export const McpRuntimeRequirementSchema = z.enum(['node', 'uv', 'git'])
export type McpRuntimeRequirement = z.infer<typeof McpRuntimeRequirementSchema>

/**
 * A value the user must supply before a package can connect. Mirrors the
 * official MCP registry `Input` shape (isRequired / isSecret / format /
 * default / placeholder) so a registry adapter can map onto it unchanged.
 * `target` says where the resolved value is applied at connect time: an
 * environment variable for stdio, or a request header for http/sse.
 */
export const McpInputSchema = z.object({
  /** Env var name or header name — also the storage key for secrets. */
  name: z.string().min(1).max(128),
  target: z.enum(['env', 'header']).default('env'),
  /** Field label; falls back to `name` when omitted. */
  label: z.string().min(1).max(128).optional(),
  description: z.string().max(512).optional(),
  placeholder: z.string().max(256).optional(),
  /** Secrets go to OS secure storage and are never written into settings.json. */
  isSecret: z.boolean().default(false),
  isRequired: z.boolean().default(true),
  /** Non-secret default prefilled into the field. */
  default: z.string().max(512).optional()
})
export type McpInput = z.infer<typeof McpInputSchema>

/** Manifest for a Vyotiq-native MCP package (`vyotiq.mcp.json`). */
export const VyotiqMcpManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('mcp'),
    id: MarketplaceSegmentSchema,
    name: z.string().min(1),
    version: MarketplaceSegmentSchema,
    description: z.string().default(''),
    transport: McpTransportSchema.default('stdio'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Optional default allow list (bare tool names) when installed. */
    allowedTools: z.array(z.string().min(1)).optional(),
    /** Optional default deny list (bare tool names) when installed. */
    deniedTools: z.array(z.string().min(1)).optional(),
    /** Drives the Connect affordance. Legacy manifests default to `none`. */
    auth: McpAuthKindSchema.default('none'),
    /** Binaries checked before spawning stdio; missing ones fail with a fixable error. */
    requires: z.array(McpRuntimeRequirementSchema).optional(),
    /** Credentials/config the user supplies before connecting (see McpInputSchema). */
    inputs: z.array(McpInputSchema).optional(),
    /** Where to read about the server. */
    docsUrl: z.string().url().optional(),
    /** Where to obtain the credential described by `inputs`. */
    setupUrl: z.string().url().optional()
  })
  .superRefine((val, ctx) => {
    if (val.transport === 'stdio' && !(val.command ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command is required for stdio transport',
        path: ['command']
      })
    }
    if (val.command && !isSafeWorkspaceRelPath(val.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command must be a safe relative path or bare binary name (no .., absolute, or traversal)',
        path: ['command']
      })
    }
    if ((val.transport === 'http' || val.transport === 'sse') && !(val.url ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url is required for http/sse transport',
        path: ['url']
      })
    }
    // startMcpOAuth refuses stdio, so an oauth stdio manifest would render a
    // Connect button that can only ever fail.
    if ((val.auth === 'oauth' || val.auth === 'oauth-client') && val.transport === 'stdio') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `auth "${val.auth}" requires http or sse transport`,
        path: ['auth']
      })
    }
    // The user has to register the app somewhere before they can paste its
    // credentials, so a setup link is part of the contract, not a nicety.
    if (val.auth === 'oauth-client' && !val.setupUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auth "oauth-client" requires setupUrl (where to register the OAuth app)',
        path: ['setupUrl']
      })
    }
    if (val.auth === 'token' && !(val.inputs ?? []).length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auth "token" requires at least one entry in inputs',
        path: ['inputs']
      })
    }
    const seen = new Set<string>()
    for (const input of val.inputs ?? []) {
      const key = `${input.target}:${input.name.toLowerCase()}`
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate input ${input.target} "${input.name}"`,
          path: ['inputs']
        })
      }
      seen.add(key)
    }
  })
export type VyotiqMcpManifest = z.infer<typeof VyotiqMcpManifestSchema>

/** Agent Skills (agentskills.io) frontmatter for `SKILL.md`. */
const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'name must be lowercase alphanumeric with single hyphens (no leading/trailing/--)'
  })
  .refine((n) => !/(?:^|-)(?:anthropic|claude)(?:-|$)/i.test(n), {
    message: 'name must not contain reserved words anthropic or claude'
  })

export const SkillFrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().min(1).optional(),
  /**
   * `true` keeps the skill out of the model's available-skills list: it is an
   * entry point for a person to reach for, not one the agent should pick from a
   * description. Slash invocation and the Skill tool still resolve it, so a skill
   * the user asks for by name always loads.
   *
   * Frontmatter is read by a line parser rather than a YAML library, so the value
   * arrives as text and only the two spellings YAML would call true are honoured.
   */
  'disable-model-invocation': z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v == null) return undefined
      if (typeof v === 'boolean') return v
      const t = v.trim().toLowerCase()
      return t === 'true' || t === 'yes' ? true : undefined
    })
})
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/** Marketplace package version from skill metadata (defaults to 1.0.0). */
export function skillPackageVersion(fm: Pick<SkillFrontmatter, 'metadata'>): string {
  const v = fm.metadata?.version?.trim()
  return v && v.length > 0 ? v : '1.0.0'
}

export const VyotiqPluginManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('plugin'),
  id: MarketplaceSegmentSchema,
  name: z.string().min(1),
  version: MarketplaceSegmentSchema,
  description: z.string().default(''),
  mcp: z.array(MarketplaceRelPathSchema).default([]),
  skills: z.array(MarketplaceRelPathSchema).default([]),
  rules: z.array(MarketplaceRelPathSchema).default([])
})
export type VyotiqPluginManifest = z.infer<typeof VyotiqPluginManifestSchema>

export const MarketplaceCatalogSectionSchema = z.enum(['discover', 'featured'])
export type MarketplaceCatalogSection = z.infer<typeof MarketplaceCatalogSectionSchema>

export const MarketplaceContentsPreviewSchema = z.object({
  mcp: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1) }))
    .optional(),
  skills: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().default('')
      })
    )
    .optional(),
  rules: z.array(z.object({ path: z.string().min(1) })).optional()
})
export type MarketplaceContentsPreview = z.infer<typeof MarketplaceContentsPreviewSchema>

export const PackageContentsSchema = z.object({
  id: z.string().min(1),
  kind: MarketplaceKindSchema,
  mcp: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      transport: McpTransportSchema.optional(),
      url: z.string().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).optional()
    })
  ),
  skills: z.array(
    z.object({ name: z.string(), description: z.string(), path: z.string() })
  ),
  rules: z.array(z.object({ path: z.string() }))
})
export type PackageContents = z.infer<typeof PackageContentsSchema>

export const MarketplaceCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  kind: MarketplaceKindSchema,
  downloadUrl: z.string().optional(),
  /** Optional hex sha256 digest of the version archive — verified before extraction. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  bundledPath: MarketplaceRelPathSchema.optional(),
  source: z.enum(['bundled', 'remote']).default('remote'),
  publisher: z.string().optional(),
  verified: z.boolean().optional(),
  sections: z.array(MarketplaceCatalogSectionSchema).optional(),
  /** Drives home category headings (e.g. infrastructure, skills, tools). */
  category: z.string().optional(),
  featuredRank: z.number().int().optional(),
  /** Relative path under resources/marketplace/ (e.g. icons/filesystem.svg). */
  iconPath: MarketplaceRelPathSchema.optional(),
  /**
   * The art is a single black ink, so the UI may invert it for a dark theme.
   * Set from the file itself when the icon is read, never authored by hand —
   * see enrichCatalogEntryIcons. Icons that carry their own colours (a vendor
   * mark we have no monochrome source for) leave it unset and are shown as-is.
   */
  iconMono: z.boolean().optional(),
  /** Image data URL only; invalid/remote schemes are dropped (not a catalog parse failure). */
  iconUrl: z
    .string()
    .optional()
    .transform((v) => {
      if (v == null || v.trim() === '') return undefined
      return isAllowedMarketplaceIconUrl(v) ? v.trim() : undefined
    }),
  /** When false, UI shows Coming soon instead of Install. Default true. */
  installable: z.boolean().optional(),
  contentsPreview: MarketplaceContentsPreviewSchema.optional(),
  /**
   * Browse-time mirror of the package manifest's `auth`, so the catalog can
   * offer Connect before anything is installed. Kept in sync with
   * `vyotiq.mcp.json` by the bundled-catalog integrity test.
   */
  auth: McpAuthKindSchema.optional(),
  /** Browse-time mirror of the manifest's `requires`. */
  requires: z.array(McpRuntimeRequirementSchema).optional(),
  /**
   * Other catalog ids this package hands control to — a skill whose body calls
   * the Skill tool with another skill's name cannot do its job alone. Installing
   * pulls these in first (bundled only, never a download), so a one-card install
   * of an interlinked suite is not a dead end. Not a dependency on a *version*:
   * an already-installed id is left exactly as the user has it, disabled ones
   * included. Ids must resolve to installable catalog entries and the graph must
   * be acyclic — both asserted by the bundled-catalog integrity test.
   */
  dependsOn: z.array(MarketplaceSegmentSchema).optional()
})
export type MarketplaceCatalogEntry = z.infer<typeof MarketplaceCatalogEntrySchema>

export const MarketplaceCatalogSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  packages: z.array(MarketplaceCatalogEntrySchema).default([])
})
export type MarketplaceCatalog = z.infer<typeof MarketplaceCatalogSchema>

export const MarketplaceInstalledItemSchema = z.object({
  id: z.string().min(1),
  kind: MarketplaceKindSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(''),
  enabled: z.boolean().default(true),
  installSource: MarketplaceInstallSourceSchema,
  installedAt: z.string().min(1),
  /** Relative path under marketplace/packages/{id}/{version} */
  /** Relative path under marketplace/packages — must be `{id}/{version}`. */
  packagePath: z
    .string()
    .min(1)
    .refine(
      (p) => {
        const t = p.trim().replace(/\\/g, '/')
        const parts = t.split('/')
        return (
          parts.length === 2 &&
          parts.every((seg) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(seg) && !seg.includes('__'))
        )
      },
      { message: 'packagePath must be id/version with safe segments' }
    )
})
export type MarketplaceInstalledItem = z.infer<typeof MarketplaceInstalledItemSchema>

export const MarketplaceInstallResultSchema = z.object({
  item: MarketplaceInstalledItemSchema,
  /** Present when a Bearer token was requested; false if secure storage failed. */
  authTokenStored: z.boolean().optional(),
  /**
   * Ids pulled in from the entry's `dependsOn` because they were missing. Empty
   * when nothing extra was needed. The UI names them, so an install that quietly
   * grew from one package to several is still something the user can see.
   */
  dependencies: z.array(z.string().min(1)).optional()
})
export type MarketplaceInstallResult = z.infer<typeof MarketplaceInstallResultSchema>

export const MarketplaceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(MarketplaceInstalledItemSchema).default([])
})
export type MarketplaceIndex = z.infer<typeof MarketplaceIndexSchema>

export const MarketplaceOverridesSchema = z.object({
  mcp: z.record(z.string(), z.boolean()).optional(),
  skills: z.record(z.string(), z.boolean()).optional(),
  plugins: z.record(z.string(), z.boolean()).optional()
})
export type MarketplaceOverrides = z.infer<typeof MarketplaceOverridesSchema>

export const MarketplaceSettingsSchema = z.object({
  registryUrl: z.string().default(''),
  remoteInstallAcked: z.boolean().default(false)
})
export type MarketplaceSettings = z.infer<typeof MarketplaceSettingsSchema>

export const DEFAULT_MARKETPLACE_SETTINGS: MarketplaceSettings = {
  registryUrl: '',
  remoteInstallAcked: false
}

/** Main-only ack write — renderer must not set remoteInstallAcked via setSettings. */
export const MarketplaceRemoteInstallAckRequestSchema = z.object({
  acked: z.boolean()
})
export type MarketplaceRemoteInstallAckRequest = z.infer<
  typeof MarketplaceRemoteInstallAckRequestSchema
>

export const MarketplaceInstallRequestSchema = z.object({
  source: MarketplaceInstallSourceSchema,
  /** Absolute folder / zip path, git URL, npm package name, catalog id, or remote MCP URL */
  target: z.string().min(1),
  version: z.string().optional(),
  kind: MarketplaceKindSchema.optional(),
  /** Display name when source is `remote` */
  name: z.string().min(1).optional(),
  /** http | sse when source is `remote` (default http) */
  transport: z.enum(['http', 'sse']).optional(),
  /** Optional Bearer token (stored in OS secure storage; never written into the package) */
  bearerToken: z.string().optional(),
  /** Extra non-secret headers (Authorization from bearerToken / safeStorage wins) */
  headers: z.record(z.string(), z.string()).optional()
})
export type MarketplaceInstallRequest = z.infer<typeof MarketplaceInstallRequestSchema>

export const MarketplaceSetEnabledRequestSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean()
})
export type MarketplaceSetEnabledRequest = z.infer<typeof MarketplaceSetEnabledRequestSchema>

export const MarketplaceUninstallRequestSchema = z.object({
  id: z.string().min(1),
  /** When uninstalling GitHub MCP, also run native GitHub logout. Default false. */
  signOutGithub: z.boolean().optional()
})
export type MarketplaceUninstallRequest = z.infer<typeof MarketplaceUninstallRequestSchema>

export const MarketplaceGetContentsRequestSchema = z.object({
  id: z.string().min(1)
})
export type MarketplaceGetContentsRequest = z.infer<typeof MarketplaceGetContentsRequestSchema>

export const MarketplaceBrowseRequestSchema = z.object({
  kind: MarketplaceKindSchema.optional(),
  q: z.string().optional()
})
export type MarketplaceBrowseRequest = z.infer<typeof MarketplaceBrowseRequestSchema>

/** Suggested MCP server shape for detect/import (mirrors settings McpServer; avoids circular import). */
export const DetectedMcpServerSchema = z.object({
  id: z
    .string()
    .min(1)
    .refine((id) => !id.includes('__'), { message: 'id must not contain "__"' }),
  name: z.string().min(1),
  transport: McpTransportSchema.default('stdio'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  deniedTools: z.array(z.string().min(1)).optional(),
  enabled: z.boolean().default(true),
  source: z.enum(['manual', 'marketplace']).optional(),
  packageId: z.string().optional(),
  packageVersion: z.string().optional()
})
export type DetectedMcpServer = z.infer<typeof DetectedMcpServerSchema>

/** Classifier kind for universal MCP paste input. */
export const McpDetectKindSchema = z.enum([
  'remote',
  'git',
  'npm',
  'stdio',
  'json',
  'vyotiq-package',
  'unknown'
])
export type McpDetectKind = z.infer<typeof McpDetectKindSchema>

export const McpDetectRequestSchema = z.object({
  input: z.string().min(1)
})
export type McpDetectRequest = z.infer<typeof McpDetectRequestSchema>

export const McpDetectResultSchema = z.object({
  kind: McpDetectKindSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  /** Suggested manual MCP server (stdio / remote). Command may be empty when detection failed. */
  server: DetectedMcpServerSchema.optional(),
  /** When a Vyotiq package was found (git/npm/path), prefer marketplace install. */
  install: MarketplaceInstallRequestSchema.optional(),
  warnings: z.array(z.string()).default([]),
  /** True when an existing server/package with the same id is already configured. */
  duplicate: z.boolean().default(false),
  /**
   * A catalog package that launches the same server — the same URL, or the
   * same launcher running the same package — so the UI can offer it instead.
   */
  catalogMatch: z.object({ id: z.string().min(1), name: z.string().min(1) }).optional()
})
export type McpDetectResult = z.infer<typeof McpDetectResultSchema>

export const McpApplyDetectedRequestSchema = z.object({
  /** Result from detect, or a user-edited server. */
  server: DetectedMcpServerSchema.optional(),
  install: MarketplaceInstallRequestSchema.optional(),
  /** When true, replace an existing manual server with the same id. */
  overwrite: z.boolean().default(false)
})
export type McpApplyDetectedRequest = z.infer<typeof McpApplyDetectedRequestSchema>

export const McpApplyDetectedResultSchema = z.object({
  applied: z.enum(['manual', 'marketplace']),
  serverId: z.string().optional(),
  installResult: MarketplaceInstallResultSchema.optional()
})
export type McpApplyDetectedResult = z.infer<typeof McpApplyDetectedResultSchema>

export const McpImportExternalRequestSchema = z.object({
  /** Absolute config file paths; empty = scan default Cursor/Claude locations. */
  paths: z.array(z.string()).optional(),
  /** Raw JSON with mcpServers (optional alternative to paths). */
  json: z.string().optional(),
  /** Prefer passing full detected servers so display names survive import. */
  servers: z.array(DetectedMcpServerSchema).optional(),
  mode: z.enum(['merge', 'replace']).default('merge'),
  /** Subset of server ids to import; omit = all. */
  selectedIds: z.array(z.string()).optional()
})
export type McpImportExternalRequest = z.infer<typeof McpImportExternalRequestSchema>

export const McpImportExternalResultSchema = z.object({
  /** Servers found before apply (for preview). */
  preview: z.array(DetectedMcpServerSchema).default([]),
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  warnings: z.array(z.string()).default([]),
  /** Default paths that were scanned (may not all exist). */
  scannedPaths: z.array(z.string()).default([])
})
export type McpImportExternalResult = z.infer<typeof McpImportExternalResultSchema>

export const McpScanExternalRequestSchema = z.object({
  paths: z.array(z.string()).optional(),
  /** A pasted `mcpServers` config, listed in place of the default paths. */
  json: z.string().optional()
})
export type McpScanExternalRequest = z.infer<typeof McpScanExternalRequestSchema>
