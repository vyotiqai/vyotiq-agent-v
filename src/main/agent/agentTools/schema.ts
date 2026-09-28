/**
 * Shape checks for agent-built tool schemas. The schema is model-written and
 * rides every step's tool list, so one malformed file fails every request on a
 * strict host: MiMo (OpenCode Go) answers `[400] Invalid request parameters`
 * for a `required` that is not a string array (2026-09-28, three files in the
 * wild shaped `required: {"item": ["url", "dest"]}` plus a property left at the
 * schema root). Lenient hosts accept the same body, which is how it survived.
 */

/** Root keywords kept on the wire; anything else at the root is dropped. */
const ROOT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
  'title',
  '$schema',
  '$defs',
  'definitions'
])

type Schema = Record<string, unknown>

function isPlainObject(value: unknown): value is Schema {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** A root key whose value reads as a property schema that missed `properties`. */
function isStrayProperty(key: string, value: unknown): boolean {
  return !ROOT_KEYWORDS.has(key) && isPlainObject(value) && typeof value.type === 'string'
}

/** Every string inside a `required` value, however it was wrapped. */
function collectNames(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectNames(v, out)
  else if (isPlainObject(value)) for (const v of Object.values(value)) collectNames(v, out)
  return out
}

/** What is wrong with a schema's top level, in words the model can act on. */
export function agentToolSchemaProblems(schema: Schema): string[] {
  const problems: string[] = []
  if (schema.type !== undefined && schema.type !== 'object') {
    problems.push(`type must be "object", got ${JSON.stringify(schema.type)}`)
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    problems.push('properties must be an object mapping each arg name to its schema')
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  if (schema.required !== undefined) {
    const req = schema.required
    if (!Array.isArray(req) || !req.every((r) => typeof r === 'string')) {
      problems.push(
        `required must be an array of arg names like ["a", "b"], got ${JSON.stringify(req)}`
      )
    } else {
      const unknown = req.filter((r) => !(r in properties))
      if (unknown.length) {
        problems.push(`required names ${JSON.stringify(unknown)} are not in properties`)
      }
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (isStrayProperty(key, value)) {
      problems.push(`"${key}" sits at the schema root; move it inside properties`)
    }
  }
  return problems
}

/**
 * The schema to send for an agent-built tool. A well-formed schema comes back
 * as the same object; a malformed one is repaired where intent is clear (stray
 * properties moved in, wrapped `required` names unwrapped and filtered to real
 * properties) and stripped of unknown root keys otherwise.
 */
export function normalizeAgentToolSchema(schema: Schema): Schema {
  if (agentToolSchemaProblems(schema).length === 0) return schema
  const properties: Schema = isPlainObject(schema.properties) ? { ...schema.properties } : {}
  const out: Schema = {}
  for (const [key, value] of Object.entries(schema)) {
    if (isStrayProperty(key, value)) {
      if (!(key in properties)) properties[key] = value
    } else if (ROOT_KEYWORDS.has(key) && key !== 'properties' && key !== 'required') {
      out[key] = value
    }
  }
  out.type = 'object'
  out.properties = properties
  const required = [...new Set(collectNames(schema.required))].filter((r) => r in properties)
  if (required.length) out.required = required
  return out
}
