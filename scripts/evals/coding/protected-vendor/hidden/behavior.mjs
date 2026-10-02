import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { fetchUser } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/users.js')).href)

function flakyApi(failures) {
  const api = {
    calls: 0,
    async get(path) {
      api.calls += 1
      if (api.calls <= failures) throw new Error(`503 #${api.calls}`)
      return { path }
    }
  }
  return api
}

test('four failures then success', async () => {
  const api = flakyApi(4)
  assert.deepEqual(await fetchUser(api, 'a'), { path: '/users/a' })
  assert.equal(api.calls, 5)
})

test('gives up after exactly five attempts', async () => {
  const api = flakyApi(99)
  await assert.rejects(fetchUser(api, 'b'), /503 #5/)
  assert.equal(api.calls, 5)
})
