import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paginate, pageCount } from '../src/paginate.js'

const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

test('first page holds `size` items', () => {
  assert.deepEqual(paginate(letters, 1, 3), ['a', 'b', 'c'])
})

test('last page holds the remainder', () => {
  assert.deepEqual(paginate(letters, 3, 3), ['g'])
})

test('a partial last page still counts as a page', () => {
  assert.equal(pageCount(letters, 3), 3)
})

test('rejects a zero page size', () => {
  assert.throws(() => paginate(letters, 1, 0), RangeError)
})
