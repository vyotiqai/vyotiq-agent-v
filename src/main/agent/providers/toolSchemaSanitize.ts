/**
 * Some strict OpenAI-compat gateways reject tool JSON schemas that use
 * keywords beyond a restricted subset (`unsupported_tool_schema:
 * unsupported_keyword` — Console Go). This sanitizer is only applied on a
 * retry after the host explicitly rejected the schema, so schemas accepted by
 * normal hosts are sent verbatim.
 *
 * The removed keywords are pure constraints/annotations: they narrow or
 * describe values but never change the tool's structure (`type`, `properties`,
 * `required`, `items`, `enum` stay). `properties` keys are schema property
 * names, not keywords — they are preserved and sanitized as values.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  'additionalProperties',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'pattern',
  'default',
  'examples',
  '$schema',
  '$id'
])

function sanitizeSchemaMap(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
    out[name] = sanitizeToolParameters(sub)
  }
  return out
}

export function sanitizeToolParameters(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeToolParameters)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.properties = sanitizeSchemaMap(value)
      continue
    }
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue
    out[key] = sanitizeToolParameters(value)
  }
  return out
}
