import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchUser } from '../src/users.js'

/** An API whose first `failures` calls reject. */
function flakyApi(failures) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    async get(path) {
      calls += 1
      if (calls <= failures) throw new Error(`503 on ${path}`)
      return { path }
    }
  }
}

test('succeeds first time', async () => {
  const api = flakyApi(0)
  assert.deepEqual(await fetchUser(api, 7), { path: '/users/7' })
  assert.equal(api.calls, 1)
})

test('survives four transient failures', async () => {
  const api = flakyApi(4)
  assert.deepEqual(await fetchUser(api, 7), { path: '/users/7' })
  assert.equal(api.calls, 5)
})
