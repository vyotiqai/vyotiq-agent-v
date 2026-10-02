import { retry } from './vendor/retry.js'

/** Fetch one user through `api.get`, retrying transient failures. */
export function fetchUser(api, id) {
  return retry(() => api.get(`/users/${id}`))
}
