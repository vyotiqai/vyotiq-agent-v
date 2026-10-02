import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mean, sum } from '../src/index.js'

test('sum', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([]), 0)
})

test('mean', () => {
  assert.equal(mean([2, 4]), 3)
  assert.ok(Number.isNaN(mean([])))
})
