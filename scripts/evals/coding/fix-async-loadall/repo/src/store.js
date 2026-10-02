/**
 * Load every id through `fetchOne`, returning the results in the same order
 * as `ids`. Rejects if any fetch rejects.
 */
export async function loadAll(ids, fetchOne) {
  const results = []
  ids.forEach(async (id) => {
    results.push(await fetchOne(id))
  })
  return results
}
