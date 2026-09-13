import { type ZodTypeAny } from 'zod'

type ZodDef = {
  typeName: string
  description?: string
  innerType?: ZodTypeAny
  schema?: ZodTypeAny
  type?: ZodTypeAny
  shape?: () => Record<string, ZodTypeAny>
  values?: string[]
  checks?: Array<{ kind: string; value?: number | string }>
  minLength?: { value: number } | null
  maxLength?: { value: number } | null
}

function defOf(schema: ZodTypeAny): ZodDef {
  return schema._def as ZodDef
}

/**
 * Peel Optional / Nullable / Default / Effects while collecting the first
 * non-empty `.describe()` on the wrapper chain. Zod attaches describe to the
 * outer wrapper when callers write `.optional().describe(...)`, so reading
 * description only after unwrap silently drops most param docs.
 */
function unwrapWithDescription(schema: ZodTypeAny): {
  inner: ZodTypeAny
  description: string | undefined
} {
  let s = schema
  let description: string | undefined
  for (;;) {
    const d = defOf(s)
    if (d.description && !description) description = d.description
    if (d.typeName === 'ZodOptional' || d.typeName === 'ZodNullable') {
      s = d.innerType as ZodTypeAny
      continue
    }
    if (d.typeName === 'ZodDefault') {
      s = d.innerType as ZodTypeAny
      continue
    }
    if (d.typeName === 'ZodEffects') {
      s = d.schema as ZodTypeAny
      continue
    }
    break
  }
  return { inner: s, description }
}

function isOptional(schema: ZodTypeAny): boolean {
  let s = schema
  for (;;) {
    const d = defOf(s)
    if (d.typeName === 'ZodOptional' || d.typeName === 'ZodDefault') return true
    if (d.typeName === 'ZodNullable' || d.typeName === 'ZodEffects') {
      s = (d.typeName === 'ZodEffects' ? d.schema : d.innerType) as ZodTypeAny
      continue
    }
    return false
  }
}

function withDescription(
  obj: Record<string, unknown>,
  description: string | undefined
): Record<string, unknown> {
  return description ? { ...obj, description } : obj
}

function numberSchema(s: ZodTypeAny, description: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'number' }
  const checks = defOf(s).checks
  if (checks) {
    for (const c of checks) {
      if (c.kind === 'int') out.type = 'integer'
      if (c.kind === 'min' && typeof c.value === 'number') out.minimum = c.value
      if (c.kind === 'max' && typeof c.value === 'number') out.maximum = c.value
    }
  }
  return withDescription(out, description)
}

function stringSchema(s: ZodTypeAny, description: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'string' }
  const checks = defOf(s).checks
  if (checks) {
    for (const c of checks) {
      if (c.kind === 'uuid') out.format = 'uuid'
      if (c.kind === 'min' && typeof c.value === 'number') out.minLength = c.value
      if (c.kind === 'max' && typeof c.value === 'number') out.maxLength = c.value
      if (c.kind === 'length' && typeof c.value === 'number') {
        out.minLength = c.value
        out.maxLength = c.value
      }
    }
  }
  return withDescription(out, description)
}

/** Minimal Zod → JSON Schema for tool / compaction definitions. */
export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return toJsonSchema(schema, true)
}

function toJsonSchema(schema: ZodTypeAny, root: boolean): Record<string, unknown> {
  const { inner: s, description } = unwrapWithDescription(schema)
  const typeName = defOf(s).typeName

  if (typeName === 'ZodString') {
    return stringSchema(s, description)
  }
  if (typeName === 'ZodNumber') {
    return numberSchema(s, description)
  }
  if (typeName === 'ZodBoolean') {
    return withDescription({ type: 'boolean' }, description)
  }
  if (typeName === 'ZodEnum') {
    const values = defOf(s).values ?? []
    return withDescription({ type: 'string', enum: [...values] }, description)
  }
  if (typeName === 'ZodArray') {
    const items = defOf(s).type as ZodTypeAny
    const out: Record<string, unknown> = {
      type: 'array',
      items: toJsonSchema(items, false)
    }
    const d = defOf(s)
    if (d.minLength && typeof d.minLength.value === 'number') out.minItems = d.minLength.value
    if (d.maxLength && typeof d.maxLength.value === 'number') out.maxItems = d.maxLength.value
    return withDescription(out, description)
  }
  if (typeName === 'ZodObject') {
    const shape = (defOf(s).shape as () => Record<string, ZodTypeAny>)()
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, field] of Object.entries(shape)) {
      properties[key] = toJsonSchema(field, false)
      if (!isOptional(field)) required.push(key)
    }
    const out: Record<string, unknown> = {
      type: 'object',
      properties,
      additionalProperties: false
    }
    if (required.length) out.required = required
    // OpenAI strict mode rejects `{}` tools that omit `required` entirely.
    else if (Object.keys(properties).length === 0) out.required = []
    return withDescription(out, description)
  }
  // A tool whose root schema converts to `{}` would accept anything — fail fast.
  if (root) {
    throw new Error(`zodToJsonSchema: unsupported root schema type "${typeName}"`)
  }
  return {}
}
