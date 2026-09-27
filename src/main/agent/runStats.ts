import { join } from 'path'
import { readJsonDocCached } from './jsonDocCache'

/** Best-effort lenient receipt cost extraction — survives partial/corrupt receipts. */
export async function readLenientReceiptCost(
  runDir: string
): Promise<{ billedCost?: number; estimatedCost?: number } | undefined> {
  const receiptPath = join(runDir, 'receipt.json')
  const doc = await readJsonDocCached(receiptPath)
  if (!doc.ok) return undefined
  try {
    const raw = doc.doc as {
      billedCost?: unknown
      estimatedCost?: unknown
    }
    const billed =
      typeof raw?.billedCost === 'number' && raw.billedCost > 0 ? raw.billedCost : undefined
    const estimated =
      typeof raw?.estimatedCost === 'number' && raw.estimatedCost > 0
        ? raw.estimatedCost
        : undefined
    if (billed == null && estimated == null) return undefined
    return {
      ...(billed != null ? { billedCost: billed } : {}),
      ...(estimated != null ? { estimatedCost: estimated } : {})
    }
  } catch {
    // Corrupt or foreign receipt — omit cost rather than guess.
  }
  return undefined
}
