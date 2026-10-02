import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const mod = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/pricing.js')).href)

/** The original implementation, frozen here as the behavioural oracle. */
function oracle(base, rate) {
  if (typeof base !== 'number' || base < 0) throw new TypeError('base must be a non-negative number')
  const discounted = base - base * rate
  return Math.round(discounted * 100) / 100
}

const bases = [0, 0.01, 1, 9.99, 10, 12.345, 19.95, 50, 99.99, 100, 123.456, 1000]

test('identical outputs to the original', () => {
  for (const base of bases) {
    assert.equal(mod.priceForStudent(base), oracle(base, 0.2), `student ${base}`)
    assert.equal(mod.priceForSenior(base), oracle(base, 0.3), `senior ${base}`)
    assert.equal(mod.priceForMember(base), oracle(base, 0.1), `member ${base}`)
  }
})

test('still rejects bad input', () => {
  for (const fn of [mod.priceForStudent, mod.priceForSenior, mod.priceForMember]) {
    assert.throws(() => fn(-5), TypeError)
    assert.throws(() => fn('10'), TypeError)
  }
})

test('applyDiscount is exported and general', () => {
  assert.equal(typeof mod.applyDiscount, 'function')
  assert.equal(mod.applyDiscount(100, 0.25), 75)
  assert.equal(mod.applyDiscount(9.99, 0.2), 7.99)
})
