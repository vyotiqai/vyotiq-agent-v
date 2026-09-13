import { createHash } from 'crypto'
import { canonicalizeWorkspacePath } from './workspacePath'

/** Fixed namespace for deterministic workspace IDs (UUID v5). */
const WORKSPACE_ID_NAMESPACE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

function parseUuid(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  return Buffer.from(hex, 'hex')
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

/** Stable opaque ID from a canonical workspace path (no path stored in logs). */
export function workspaceIdFromCanonical(canonicalPath: string): string {
  const namespaceBytes = parseUuid(WORKSPACE_ID_NAMESPACE)
  const hash = createHash('sha1')
  hash.update(namespaceBytes)
  hash.update(canonicalPath, 'utf8')
  const digest = hash.digest()
  digest[6] = (digest[6]! & 0x0f) | 0x50
  digest[8] = (digest[8]! & 0x3f) | 0x80
  return formatUuid(digest.subarray(0, 16))
}

/** Stable opaque ID from any workspace path string. */
export function workspaceIdFromPath(workspacePath: string): string {
  return workspaceIdFromCanonical(canonicalizeWorkspacePath(workspacePath))
}
