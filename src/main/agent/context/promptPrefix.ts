import { createHash } from 'node:crypto'

/**
 * Fingerprint of everything a request carries ahead of the conversation: the
 * tool catalog and the stable system zone. Providers cache by prefix, so this
 * is the part that has to stay byte-identical from step to step. The volatile
 * zone is excluded on purpose, because every adapter sends it after the
 * history.
 *
 * Recorded on `step_usage` as `prefixHash`, it tells a cold step's two causes
 * apart without reconstructing the request. If the hash matches the previous
 * step's, the request sent the same prefix and the provider lost the cache. If
 * it changed, the request rewrote its own prefix. Measured 2026-09-23: 4 of 16
 * mid-run cold steps were the second kind (`create_plan` writing into the
 * stable zone), and 12 were the gateway moving the session between cache
 * servers. Only token sizes were recorded then, and they cannot see a
 * same-length change.
 */
export function promptPrefixFingerprint(
  tools: readonly unknown[],
  systemStable: string | undefined
): string {
  return createHash('sha256')
    .update(JSON.stringify(tools))
    .update('\u0000')
    .update(systemStable ?? '')
    .digest('hex')
    .slice(0, 16)
}
