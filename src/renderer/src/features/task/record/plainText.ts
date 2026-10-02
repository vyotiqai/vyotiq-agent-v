/**
 * Text as the record shows it. A plan's step, a child's report title, a
 * brief's `code` span: the record sets markdown and backticks as type, so the
 * marks themselves never reach the screen. Find in record matches on these
 * same strings, so what it opens is what it then finds on screen.
 */

/**
 * Markdown as plain words for a surface that shows text, not markdown: heading
 * marks, emphasis and link targets dropped; code spans kept (and a
 * `[[path:line]]` citation made one) for `TickedText` to set.
 */
export function plainProse(text: string): string {
  return text
    .replace(/^[ \t]*#+[ \t]*/gm, '')
    .replace(/\[\[([^[\]\n]+)\]\]/g, '`$1`')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    // A single mark opens on a letter or digit: `src/*.ts and lib/*.js` is a glob, not emphasis.
    .replace(/(^|[^\w*`])([*_])(?=[\p{L}\p{N}])(.+?)(?<=\S)\2(?=[^\w*]|$)/gmu, '$1$3')
}

/**
 * One line of markdown as plain words, for a title: heading marks, emphasis,
 * code ticks and link targets dropped ("Checks recorded: **4 met**" →
 * "Checks recorded: 4 met").
 */
export function plainLine(line: string): string {
  return untick(plainProse(line)).trim()
}

/**
 * Text as `TickedText` draws it: a `code` span or a `[[citation]]` keeps its
 * words and loses its marks.
 */
export function untick(text: string): string {
  return text.replace(/`([^`\n]+)`/g, '$1').replace(/\[\[([^[\]\n]+)\]\]/g, '$1')
}
