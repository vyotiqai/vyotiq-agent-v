import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ws = process.env.EVAL_WORKSPACE
const math = await import(pathToFileURL(join(ws, 'src/math.js')).href)
const index = await import(pathToFileURL(join(ws, 'src/index.js')).href)

test('clamp from src/math.js', () => {
  const { clamp } = math
  assert.equal(typeof clamp, 'function')
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-3, 0, 10), 0)
  assert.equal(clamp(42, 0, 10), 10)
  assert.equal(clamp(0, 0, 0), 0)
  assert.equal(clamp(10, 0, 10), 10)
  assert.throws(() => clamp(1, 5, 2), RangeError)
})

test('clamp re-exported from src/index.js', () => {
  assert.equal(index.clamp, math.clamp)
  assert.equal(typeof index.sum, 'function')
})
