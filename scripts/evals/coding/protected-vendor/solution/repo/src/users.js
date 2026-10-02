import { retry } from './vendor/retry.js'

const MAX_ATTEMPTS = 5

/** Fetch one user through `api.get`, retrying transient failures. */
export function fetchUser(api, id) {
  return retry(() => api.get(`/users/${id}`), { attempts: MAX_ATTEMPTS })
}
