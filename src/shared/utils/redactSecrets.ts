/**
 * Secrets out of text that is about to be kept: task records on disk. Only
 * shapes that are secrets by construction — provider and platform keys,
 * private-key blocks, bearer and basic credentials, JWTs, AWS access key ids —
 * never paths, attachments or ordinary code like `token: string`, which the
 * logger's broader scrubber would rewrite.
 *
 * Every pattern stops at quotes and backslashes, so redacting a JSON string's
 * contents (or a fragment of one) never breaks its escaping.
 */

export const REDACTED_SECRET = '[redacted:secret]'

const TOKEN = String.raw`[A-Za-z0-9_\-]`

const PATTERNS: readonly RegExp[] = [
  // PEM private keys, whole block (headers name the key type). Never across a
  // quote, so a key inside one JSON string stays inside it.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^"]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // OpenAI / Anthropic / OpenRouter / DeepSeek style: sk-…, sk-ant-…, sk-or-…, sk-proj-…
  new RegExp(String.raw`\bsk-(?:ant-|or-|proj-|svcacct-)?${TOKEN}{20,}`, 'g'),
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // xAI, Groq.
  new RegExp(String.raw`\bxai-${TOKEN}{20,}`, 'g'),
  new RegExp(String.raw`\bgsk_${TOKEN}{20,}`, 'g'),
  // GitHub tokens (classic and fine-grained), GitLab personal tokens.
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  new RegExp(String.raw`\bglpat-${TOKEN}{20,}`, 'g'),
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids (the secret half has no fixed shape; the pair travels together).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Bedrock API keys.
  /\bABSK[A-Za-z0-9+/=]{40,}/g,
  // Stripe secret / restricted keys.
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
]

/** `Authorization: Bearer <token>` and friends keep their scheme word. */
const CREDENTIAL_SCHEMES = String.raw`\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}`

/** Every shape in one pass: a record holds thousands of short strings. */
const ANY_SECRET = new RegExp([...PATTERNS.map((p) => `(?:${p.source})`), CREDENTIAL_SCHEMES].join('|'), 'g')

/** Shorter than the shortest shape (`xoxb-` and ten characters): nothing to find. */
const MIN_SECRET_LENGTH = 15

/** Replace secret-shaped substrings; returns the same string when there are none. */
export function redactSecretsInText(text: string): string {
  if (!text || text.length < MIN_SECRET_LENGTH) return text
  return text.replace(ANY_SECRET, (_m, scheme: string | undefined) => (scheme ? `${scheme} ${REDACTED_SECRET}` : REDACTED_SECRET))
}

/** True when the text holds something redactSecretsInText would replace. */
export function containsSecret(text: string): boolean {
  return redactSecretsInText(text) !== text
}
