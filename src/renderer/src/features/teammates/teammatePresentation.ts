import type { IconName } from '@renderer/lib/icons'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import type { AgentProfile } from '@shared/ipc'

/**
 * Shared vocabulary for the teammates surfaces: which avatars can be picked,
 * and the scope rules that decide where a teammate may actually be used.
 */

/**
 * Avatar keys offered in the picker.
 *
 * `AgentProfile.avatar` stores a plain string, so any icon key is legal and a
 * roster from another build may name one that is not here — `Avatar` falls
 * back to the initial rather than failing. This list is only what the picker
 * offers.
 */
export const TEAMMATE_AVATARS: readonly IconName[] = [
  'bot',
  'sparkles',
  'cpu',
  'terminal',
  'branch',
  'flag',
  'memory',
  'stack',
  'scanSearch',
  'listTodo',
  'chat',
  'doc',
  'globe',
  'star',
  'plug',
  'monitor',
  'search',
  'image',
  'mic',
  'gear'
]

/** Human label for a workspace path, for scope badges and pickers. */
export function workspaceLabel(path: string | null): string {
  return formatWorkspaceName(path, 'this workspace')
}

/**
 * Can this teammate actually run here?
 *
 * The roster is global and unfiltered, but main refuses to resolve a
 * workspace-scoped profile outside its own workspace — a bound chat would fail
 * on send with `Unknown agent profile`, and an assigned task would fail with
 * `Unknown teammate profile`. Every surface that offers a teammate for work
 * must ask this first, so the refusal happens in the UI rather than mid-run.
 */
export function isProfileUsableIn(
  profile: AgentProfile,
  workspacePath: string | null | undefined
): boolean {
  if (profile.scope !== 'workspace') return true
  if (!workspacePath || !profile.workspacePath) return false
  return workspacePathsEqual(workspacePath, profile.workspacePath)
}

/** Short scope badge text, or null for an ordinary global teammate. */
export function profileScopeLabel(profile: AgentProfile): string | null {
  if (profile.scope !== 'workspace') return null
  return workspaceLabel(profile.workspacePath ?? null)
}

/** Why a teammate cannot be used here, phrased for a tooltip or a disabled control. */
export function unusableReason(
  profile: AgentProfile,
  workspacePath: string | null | undefined
): string | null {
  if (isProfileUsableIn(profile, workspacePath)) return null
  return `${profile.name} belongs to ${workspaceLabel(profile.workspacePath ?? null)} and cannot run here.`
}
