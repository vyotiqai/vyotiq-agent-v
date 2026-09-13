import { randomBytes } from 'crypto'
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
 * Wrap retrieved / workspace-controlled bytes as data, not instructions.
 * Close-tag sequences inside `body` are neutralized; a nonce marks this wrap.
 */
export function wrapUntrustedContent(body: string, opts: WrapUntrustedOptions): string {
  const nonce = randomBytes(8).toString('hex')
  const origin = (opts.origin ?? 'unknown').replace(/\s+/g, ' ').trim() || 'unknown'
  const kind = (opts.kind ?? '').replace(/\s+/g, ' ').trim()
  const kindAttr = kind ? ` kind="${escapeAttr(kind)}"` : ''
  return [
    `<untrusted_content source="${escapeAttr(opts.source)}" nonce="${nonce}" origin="${escapeAttr(origin)}"${kindAttr}>`,
    neutralizeUntrustedBody(body),
    '</untrusted_content>'
  ].join('\n')
}
