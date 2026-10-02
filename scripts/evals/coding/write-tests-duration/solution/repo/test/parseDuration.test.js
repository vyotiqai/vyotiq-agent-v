import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/parseDuration.js'

test('hours', () => {
  assert.equal(parseDuration('2h'), 7200)
})

test('minutes', () => {
  assert.equal(parseDuration('5m'), 300)
})

test('seconds', () => {
  assert.equal(parseDuration('45s'), 45)
})

test('combined units', () => {
  assert.equal(parseDuration('1h30m'), 5400)
  assert.equal(parseDuration('1h2m3s'), 3723)
})

test('whitespace around and between parts', () => {
  assert.equal(parseDuration('  1h30m  '), 5400)
  assert.equal(parseDuration('2h 5m 10s'), 7510)
})

test('invalid input throws', () => {
  for (const bad of ['', '   ', 'abc', '5x', '30m1h', '1.5h']) {
    assert.throws(() => parseDuration(bad), SyntaxError, bad)
  }
  assert.throws(() => parseDuration(42), TypeError)
})
