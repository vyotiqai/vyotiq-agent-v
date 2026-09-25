import { createHmac, randomBytes } from 'crypto'
import { HARNESS_SECTION_TAGS } from './harnessSections'
import { neutralizeXmlTags, OVERLAY_SECTION_TAGS } from './promptSections'

/**
 * Sources whose bytes can carry prompt-injection payloads. Marketplace skills,
 * plugin rules, and workspace-authored rule files are deliberately included:
 * all three reach the model verbatim today.
 */
export type UntrustedSource = 'workspace_harness' | 'browser' | 'mcp' | 'skill' | 'workspace_rules'

export type WrapUntrustedOptions = {
  source: UntrustedSource
  origin?: string
  kind?: string
}

const UNTRUSTED_STRUCTURAL_TAGS = [
  'untrusted_content',
  ...HARNESS_SECTION_TAGS,
  ...OVERLAY_SECTION_TAGS
] as const

function escapeAttr(value: string): string {
  return value.replace(/["&<>]/g, (ch) => {
    switch (ch) {
      case '"':
        return '&quot;'
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      default:
        return ch
    }
  })
}

/** Neutralize fence-break attempts so a body cannot close the envelope. */
export function neutralizeUntrustedBody(body: string): string {
  return neutralizeXmlTags(body, UNTRUSTED_STRUCTURAL_TAGS)
}

/**
 * Per-process fence secret. Never leaves the main process and never reaches the
 * model, so a nonce derived from it stays unguessable from the transcript.
 */
const FENCE_SECRET = randomBytes(32)

/**
 * Fence nonce for one wrap.
 *
 * Derived, not random. `wrapUntrustedContent` runs on every `assembleContext`
 * (workspace rules, harness appendix), so a fresh random value per call made the
 * "stable" system prefix differ byte-for-byte every step — defeating both the
 * in-process prefix cache and the provider's cache_control breakpoint. Keying on
 * the content means identical input yields identical bytes, while the secret
 * keeps the value unpredictable to anything that can only see the body.
 * `neutralizeUntrustedBody` remains the primary fence defense.
 */
function fenceNonce(source: string, origin: string, kind: string, body: string): string {
  return createHmac('sha256', FENCE_SECRET)
    .update(`${source}\0${origin}\0${kind}\0${body}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Wrap retrieved / workspace-controlled bytes as data, not instructions.
 * Close-tag sequences inside `body` are neutralized; a nonce marks this wrap.
 */
export function wrapUntrustedContent(body: string, opts: WrapUntrustedOptions): string {
  const origin = (opts.origin ?? 'unknown').replace(/\s+/g, ' ').trim() || 'unknown'
  const kind = (opts.kind ?? '').replace(/\s+/g, ' ').trim()
  const kindAttr = kind ? ` kind="${escapeAttr(kind)}"` : ''
  const nonce = fenceNonce(opts.source, origin, kind, body)
  return [
    `<untrusted_content source="${escapeAttr(opts.source)}" nonce="${nonce}" origin="${escapeAttr(origin)}"${kindAttr}>`,
    neutralizeUntrustedBody(body),
    '</untrusted_content>'
  ].join('\n')
}
