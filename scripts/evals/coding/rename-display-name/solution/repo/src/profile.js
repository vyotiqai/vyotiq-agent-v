import { getDisplayName } from './displayName.js'

export function profileCard(user) {
  const name = getDisplayName(user)
  const role = user.role ?? 'member'
  return `${name} (${role})`
}
