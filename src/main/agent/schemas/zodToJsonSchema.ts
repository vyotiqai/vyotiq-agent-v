import type { ZodType } from 'zod'

/**
 * The parts of a zod 4 definition this walker reads. zod 4 keeps them on
 * `_zod.def`, with each check's own definition on the check.
 */
type ZodDef = {
  type: string
  innerType?: ZodType
  in?: ZodType
  out?: ZodType
  element?: ZodType
  shape?: Record<string, ZodType>
  valueType?: ZodType
  entries?: Record<string, string | number>
  checks?: Array<{ _zod: { def: ZodCheckDef } }>
}

type ZodCheckDef = {
  check: string
  value?: unknown
  format?: string
  minimum?: number
  maximum?: number
  length?: number
}

function defOf(schema: ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def
}

function checksOf(schema: ZodType): ZodCheckDef[] {
  return (defOf(schema).checks ?? []).map((c) => c._zod.def)
}

/** The name error messages use, in the `ZodString` form the docs and tests know. */
function typeNameOf(schema: ZodType): string {
  const type = defOf(schema).type
  return `Zod${type.charAt(0).toUpperCase()}${type.slice(1)}`
}

/**
 * A pipe is what `.transform()` (schema in, transform out) and `z.preprocess()`
 * (transform in, schema out) build; the side that is a schema is what the model
 * must send. Refinements are checks on the schema itself and need no peeling.
 */
function pipeSchema(d: ZodDef): ZodType {
  return (defOf(d.in as ZodType).type === 'transform' ? d.out : d.in) as ZodType
}

/**
 * Peel Optional / Nullable / Default / Pipe while collecting the first
 * non-empty `.describe()` on the wrapper chain. Zod attaches describe to the
 * outer wrapper when callers write `.optional().describe(...)`, so reading
 * description only after unwrap silently drops most param docs.
 */
function unwrapWithDescription(schema: ZodType): {
  inner: ZodType
  description: string | undefined
} {
  let s = schema
  let description: string | undefined
  for (;;) {
    if (s.description && !description) description = s.description
    const d = defOf(s)
    if (d.type === 'optional' || d.type === 'nullable' || d.type === 'default') {
      s = d.innerType as ZodType
      continue
    }
    if (d.type === 'pipe') {
      s = pipeSchema(d)
      continue
    }
    break
  }
  return { inner: s, description }
}

function isOptional(schema: ZodType): boolean {
  let s = schema
  for (;;) {
    const d = defOf(s)
    if (d.type === 'optional' || d.type === 'default') return true
    if (d.type === 'nullable') {
      s = d.innerType as ZodType
      continue
    }
    if (d.type === 'pipe') {
      s = pipeSchema(d)
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

function numberSchema(s: ZodType, description: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'number' }
  for (const c of checksOf(s)) {
    if (c.check === 'number_format' && c.format?.includes('int')) out.type = 'integer'
    // Bounds are emitted whether or not they are inclusive, as they always were.
    if (c.check === 'greater_than' && typeof c.value === 'number') out.minimum = c.value
    if (c.check === 'less_than' && typeof c.value === 'number') out.maximum = c.value
  }
  return withDescription(out, description)
}

function stringSchema(s: ZodType, description: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'string' }
  for (const c of checksOf(s)) {
    if (c.check === 'string_format' && c.format === 'uuid') out.format = 'uuid'
    if (c.check === 'min_length' && typeof c.minimum === 'number') out.minLength = c.minimum
    if (c.check === 'max_length' && typeof c.maximum === 'number') out.maxLength = c.maximum
    if (c.check === 'length_equals' && typeof c.length === 'number') {
      out.minLength = c.length
      out.maxLength = c.length
    }
  }
  return withDescription(out, description)
}

/** Minimal Zod → JSON Schema for tool / compaction definitions. */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  return toJsonSchema(schema, '(root)')
}

function toJsonSchema(schema: ZodType, path: string): Record<string, unknown> {
  const { inner: s, description } = unwrapWithDescription(schema)
  const typeName = typeNameOf(s)

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
    const values = Object.values(defOf(s).entries ?? {})
    return withDescription({ type: 'string', enum: values }, description)
  }
  if (typeName === 'ZodArray') {
    const items = defOf(s).element as ZodType
    const out: Record<string, unknown> = {
      type: 'array',
      items: toJsonSchema(items, `${path}[]`)
    }
    for (const c of checksOf(s)) {
      if (c.check === 'min_length' && typeof c.minimum === 'number') out.minItems = c.minimum
      if (c.check === 'max_length' && typeof c.maximum === 'number') out.maxItems = c.maximum
    }
    return withDescription(out, description)
  }
  if (typeName === 'ZodObject') {
    const shape = defOf(s).shape ?? {}
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, field] of Object.entries(shape)) {
      properties[key] = toJsonSchema(field, `${path}.${key}`)
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
  if (typeName === 'ZodRecord') {
    // Open-ended string keys: JSON Schema expresses them as additionalProperties.
    const valueType = defOf(s).valueType
    return withDescription(
      {
        type: 'object',
        additionalProperties: valueType
          ? toJsonSchema(valueType, `${path}.*`)
          : true
      },
      description
    )
  }
  if (typeName === 'ZodUnknown' || typeName === 'ZodAny') {
    // A genuinely free-form value — build_tool's `schema` really is arbitrary
    // JSON Schema. Allowed only WITH a description, which is precisely the
    // condition the guard below exists to enforce: the objection to `{}` is
    // that it tells the model nothing, not that open values are never valid.
    if (!description) {
      throw new Error(
        `zodToJsonSchema: "${typeName}" at ${path} needs a .describe() — an open value with no description tells the model nothing`
      )
    }
    return withDescription({}, description)
  }
  // `{}` accepts anything and carries no description, so the model gets no
  // guidance at all for that argument. Fail at import time — where a test or a
  // dev build catches it — instead of shipping a silently erased tool schema.
  throw new Error(`zodToJsonSchema: unsupported schema type "${typeName}" at ${path}`)
}
