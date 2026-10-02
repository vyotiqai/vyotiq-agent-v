import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceForMember, priceForSenior, priceForStudent } from '../src/pricing.js'

test('discounts', () => {
  assert.equal(priceForStudent(50), 40)
  assert.equal(priceForSenior(50), 35)
  assert.equal(priceForMember(50), 45)
})

test('rounds to the cent', () => {
  assert.equal(priceForStudent(9.99), 7.99)
})

test('rejects negative prices', () => {
  assert.throws(() => priceForMember(-1), TypeError)
})
