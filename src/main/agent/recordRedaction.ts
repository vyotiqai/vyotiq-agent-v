import { redactSecretsInText } from '../../shared/utils/redactSecrets'

/**
 * Task records keep no secrets: messages and events are copied with
 * secret-shaped text replaced before they reach disk. The objects the run
 * holds in memory are never touched, so the step that read a key still has it;
 * later turns rebuilt from disk see `[redacted:secret]` instead.
 *
 * Opaque fields pass through untouched: provider reasoning state (signed or
 * encrypted — changing a byte breaks the replay) and attachment bytes, whether
 * a `data` field or a `data:` URI. An ordinary link is text like any other: a
 * token in its query string is redacted.
 */

const OPAQUE_KEYS = new Set(['reasoningState', 'data', 'artifact', 'signature', 'encrypted_content', 'outputItems'])

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.startsWith('data:') ? value : redactSecretsInText(value)
  if (depth > 12 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null
    for (let i = 0; i < value.length; i++) {
      const next = redactValue(value[i], depth + 1)
      if (next !== value[i]) {
        copy ??= value.slice()
        copy[i] = next
      }
    }
    return copy ?? value
  }
  let copy: Record<string, unknown> | null = null
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (OPAQUE_KEYS.has(key)) continue
    const next = redactValue(field, depth + 1)
    if (next !== field) {
      copy ??= { ...(value as Record<string, unknown>) }
      copy[key] = next
    }
  }
  return copy ?? value
}

/**
 * The record copy of a message or event: the same object when there was
 * nothing to redact (the common case costs no allocation), else a copy with
 * only the changed branches rebuilt.
 */
export function redactForRecord<T>(value: T): T {
  return redactValue(value, 0) as T
}
