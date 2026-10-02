import { getDisplayName } from './displayName.js'

export function greet(user) {
  return `Hello, ${getDisplayName(user)}!`
}
