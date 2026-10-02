/**
 * Load every id through `fetchOne`, returning the results in the same order
 * as `ids`. Rejects if any fetch rejects.
 */
export async function loadAll(ids, fetchOne) {
  return Promise.all(ids.map((id) => fetchOne(id)))
}
