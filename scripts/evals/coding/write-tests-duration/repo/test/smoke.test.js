import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/parseDuration.js'

test('parseDuration is exported', () => {
  assert.equal(typeof parseDuration, 'function')
})
