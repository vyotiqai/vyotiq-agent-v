import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { paginate, pageCount } = await import(
  pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/paginate.js')).href
)

test('middle page', () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5, 6], 2, 2), [3, 4])
})

test('page past the end is empty', () => {
  assert.deepEqual(paginate([1, 2, 3], 5, 2), [])
})

test('page size 1', () => {
  assert.deepEqual(paginate([1, 2, 3], 2, 1), [2])
})

test('pageCount of exact multiple, partial and empty', () => {
  assert.equal(pageCount([1, 2, 3, 4], 2), 2)
  assert.equal(pageCount([1, 2, 3, 4, 5], 2), 3)
  assert.equal(pageCount([], 4), 0)
})
