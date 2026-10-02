import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { loadAll } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/store.js')).href)

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

test('keeps input order when fetches finish out of order', async () => {
  const ids = [1, 2, 3, 4]
  const out = await loadAll(ids, (id) => delay(40 - id * 10, `v${id}`))
  assert.deepEqual(out, ['v1', 'v2', 'v3', 'v4'])
})

test('rejects when one fetch fails', async () => {
  await assert.rejects(
    loadAll([1, 2], async (id) => {
      if (id === 2) throw new Error('boom 2')
      return id
    }),
    /boom 2/
  )
})

test('empty input', async () => {
  assert.deepEqual(await loadAll([], async () => 1), [])
})
