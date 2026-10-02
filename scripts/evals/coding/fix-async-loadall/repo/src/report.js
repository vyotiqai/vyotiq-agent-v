import { loadAll } from './store.js'

/** Summarise orders: how many, and the total in cents. */
export async function orderReport(orderIds, fetchOrder) {
  const orders = await loadAll(orderIds, fetchOrder)
  return {
    count: orders.length,
    totalCents: orders.reduce((sum, o) => sum + o.totalCents, 0)
  }
}
