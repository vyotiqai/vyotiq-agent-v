import { getUserName } from './userName.js'

export function profileCard(user) {
  const name = getUserName(user)
  const role = user.role ?? 'member'
  return `${name} (${role})`
}
