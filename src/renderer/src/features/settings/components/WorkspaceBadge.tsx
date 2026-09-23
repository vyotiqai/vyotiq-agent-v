import { Badge } from '@renderer/lib/ui'

/**
 * Marks a row that reads from, and saves to, the active workspace's override.
 *
 * Only shown while that override is on. It answers "why doesn't this match my
 * other workspace?" on the row itself — the section-top paragraph that used to
 * list every overridable setting by name had to be read, and kept drifting from
 * the rows it described.
 */
export function workspaceBadge(overrideActive: boolean) {
  return overrideActive ? (
    <Badge title="Saved to this workspace's override">Workspace</Badge>
  ) : undefined
}
