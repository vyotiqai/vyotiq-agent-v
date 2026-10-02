import { getUserName } from './userName.js'

export function greet(user) {
  return `Hello, ${getUserName(user)}!`
}
