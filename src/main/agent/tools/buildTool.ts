/**
 * build_tool: writes a reusable agent-built tool (.mjs) into the agent tools
 * dir. The file starts with a `/* @agent-tool {json} *\/` header built from
 * name, description, and schema, followed by the agent's code, which must
 * export `async function handler(args, ctx)`.
 */
import { mkdir, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { ensureAgentToolsDir, pathSafeName } from '../agentTools/paths'

export type BuildToolInput = {
  name: string
  description: string
  /** JSON schema for the handler args (stored as inputSchema in the header). */
  schema: Record<string, unknown>
  /** Module body; must export async function handler(args, ctx). */
  code: string
  /** Replace an existing tool file (default false). */
  overwrite?: boolean
}

export type BuildToolResult = {
  /** Absolute path of the written .mjs. */
  written: string
}

export const TOOL_DEF = {
  name: 'build_tool',
  description:
    'Write a reusable agent tool into the agent tools dir as `<name>.mjs`. The file gets a `/* @agent-tool {json} */` header built from name, description, and schema (used as inputSchema), followed by your code, which must include `export async function handler(args, ctx)` returning a JSON-serializable value. Pass overwrite: true to replace an existing tool file.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Tool name: lowercase [a-z0-9_-], max 32 chars' },
      description: { type: 'string', description: 'Short description surfaced to the model' },
      schema: { type: 'object', description: 'JSON schema describing the handler args' },
      code: {
        type: 'string',
        description: 'Module body; must export async function handler(args, ctx)'
      },
      overwrite: { type: 'boolean', description: 'Replace an existing file (default false)' }
    },
    required: ['name', 'description', 'schema', 'code']
  }
} as const

/**
 * Compose and write `<toolsDir>/<name>.mjs`. The tools dir is resolved lazily
 * at call time via ensureAgentToolsDir, so stubbing app.getPath('userData') in
 * tests works without any special setup.
 */
export async function handler(input: unknown): Promise<BuildToolResult> {
  if (input == null || typeof input !== 'object') {
    throw new Error('build_tool requires an input object')
  }
  const { name, description, schema, code, overwrite } = input as Partial<BuildToolInput>

  const safe = pathSafeName(typeof name === 'string' ? name : '')
  if (!safe) {
    throw new Error(
      `Invalid tool name ${JSON.stringify(name ?? '')}: use lowercase [a-z0-9_-], max 32 chars`
    )
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('build_tool requires a non-empty description')
  }
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('build_tool requires schema to be a JSON object')
  }
  if (typeof code !== 'string' || !code.trim()) {
    throw new Error('build_tool requires non-empty code')
  }
  if (!/export\s+async\s+function\s+handler\s*\(/.test(code)) {
    throw new Error('code must export async function handler(args, ctx)')
  }

  const dir = await ensureAgentToolsDir()
  const target = join(dir, `${safe}.mjs`)
  let exists = false
  try {
    await stat(target)
    exists = true
  } catch {
    /* new file */
  }
  if (exists && overwrite !== true) {
    throw new Error(`Tool file already exists: ${target}. Pass overwrite: true to replace it.`)
  }

  const headerJson = JSON.stringify(
    { name: safe, description: description.trim(), inputSchema: schema },
    null,
    2
  )
  // A `*/` inside the serialized header would terminate the comment early and
  // corrupt the file — refuse instead of writing a broken tool.
  if (headerJson.includes('*/')) {
    throw new Error('name, description, or schema must not contain the sequence */')
  }
  const contents = `/* @agent-tool ${headerJson} */\n\n${code.trimEnd()}\n`
  await mkdir(dir, { recursive: true })
  await writeFile(target, contents, 'utf8')
  return { written: target }
}
