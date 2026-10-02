/** Upper-case the first character, leave the rest alone. */
export function capitalize(text) {
  if (!text) return text
  return text[0].toUpperCase() + text.slice(1)
}

/** Shorten `text` to at most `max` characters, ending in an ellipsis when cut. */
export function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Lower-case, collapse every non [a-z0-9] run to '-', trim '-' from both ends. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
