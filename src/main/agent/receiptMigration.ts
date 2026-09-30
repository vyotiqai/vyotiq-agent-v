import { RUN_RECEIPT_VERSION } from '../../shared/ipc'

/**
 * Lift a receipt written by an older app build (versions 2, 3, 4) to the
 * current `RUN_RECEIPT_VERSION` so it satisfies `RunReceiptSchema`.
 *
 * Every reader of `receipt.json` must run the raw document through this before
 * `RunReceiptSchema.safeParse` — a legacy version is a `z.literal` mismatch, so
 * an unmigrated parse drops the run silently (no receipt, no `verification:`
 * line, no `wroteFiles:` block in the parent's view of the child).
 */
export function migrateLegacyReceipt(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const receipt = raw as Record<string, unknown>
  const version = receipt.version
  if (version !== 2 && version !== 3 && version !== 4) return raw

  const diagnostics =
    receipt.diagnostics && typeof receipt.diagnostics === 'object' && !Array.isArray(receipt.diagnostics)
      ? (receipt.diagnostics as Record<string, unknown>)
      : {}
  // A migrated receipt must satisfy RunReceiptSchema: `diagnostics` requires
  // integer calls/ok/clean, and copying the raw values through left `undefined`
  // (or a non-integer) in the object — the parse then failed and the whole
  // legacy run was silently dropped from the review. Coerce every field the
  // same way; an unreported count reads as 0, never as a missing document.
  const count = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0

  const {
    verifyBeforeDone: _verifyBeforeDone,
    contractDoneWhen: _contractDoneWhen,
    ...rest
  } = receipt

  return {
    ...rest,
    version: RUN_RECEIPT_VERSION,
    diagnostics: {
      calls: count(diagnostics.calls),
      ok: count(diagnostics.ok),
      clean: count(diagnostics.clean)
    }
  }
}
