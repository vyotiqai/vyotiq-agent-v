import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capitalize, truncate } from '../src/strings.js'

test('capitalize upper-cases the first letter only', () => {
  assert.equal(capitalize('hello world'), 'Hello world')
  assert.equal(capitalize(''), '')
})

test('truncate leaves short text alone and cuts long text', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('a long sentence', 6), 'a lon…')
})
