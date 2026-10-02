import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers'
import { orderReport } from '../src/report.js'

const ORDERS = {
  a: { id: 'a', totalCents: 1000 },
  b: { id: 'b', totalCents: 250 },
  c: { id: 'c', totalCents: 4999 }
}

/** Like the real order service: answers after a short network delay. */
const fetchOrder = (id) => new Promise((resolve) => setTimeout(() => resolve(ORDERS[id]), 5))

test('orderReport counts and totals every order', async () => {
  assert.deepEqual(await orderReport(['a', 'b', 'c'], fetchOrder), { count: 3, totalCents: 6249 })
})

test('orderReport of nothing', async () => {
  assert.deepEqual(await orderReport([], fetchOrder), { count: 0, totalCents: 0 })
})
