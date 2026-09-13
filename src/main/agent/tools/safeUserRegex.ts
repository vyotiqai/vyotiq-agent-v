/** Max length for agent-supplied regex patterns (terminal wait, grep, etc.). */
export const USER_REGEX_MAX_LENGTH = 200

/** Max length for MCP/JSON-Schema regex patterns; schema patterns can be longer. */
export const SCHEMA_REGEX_MAX_LENGTH = 2000

function compileWithLimit(
  pattern: string,
  flags: string | undefined,
  maxLength: number | undefined
): RegExp {
  const trimmed = pattern.trim()
  if (!trimmed) throw new Error('Empty regex pattern')
  if (maxLength != null && trimmed.length > maxLength) {
    throw new Error(`Regex pattern exceeds ${maxLength} characters`)
  }
  // Classic nested quantifiers: (a+)+, (a*)*, (a+){2,}
  if (/[+*]\)[+*{]/.test(trimmed)) {
    throw new Error('Regex pattern looks too complex (nested quantifiers)')
  }
  try {
    return flags === undefined ? new RegExp(trimmed) : new RegExp(trimmed, flags)
  } catch (err) {
    if (err instanceof Error && /exceeds|too complex|Empty regex/.test(err.message)) throw err
    throw new Error(`Invalid regex pattern: ${pattern}`)
  }
}

/**
 * Compile an untrusted regex with nested-quantifier guards (ReDoS mitigation).
 * Nested quantifiers are rejected as a line of defense. Prefer RE2/worker timeouts for stronger guarantees later.
 */
export function compileUserRegex(pattern: string, flags?: string): RegExp {
  return compileWithLimit(pattern, flags, undefined)
}

/**
 * Compile a regex from an MCP tool JSON-Schema `pattern` constraint.
 * Schema patterns may be longer than user-supplied regexes, but still need
 * guards against catastrophic patterns.
 */
export function compileSchemaPattern(pattern: string, flags?: string): RegExp {
  return compileWithLimit(pattern, flags, SCHEMA_REGEX_MAX_LENGTH)
}
