/**
 * Return page `page` (1-based) of `items`, `size` items per page.
 * Pages past the end are empty.
 */
export function paginate(items, page, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer')
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer')
  const start = (page - 1) * size
  return items.slice(start, start + size)
}

/** How many pages `items` fills at `size` items per page. */
export function pageCount(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer')
  return Math.ceil(items.length / size)
}
