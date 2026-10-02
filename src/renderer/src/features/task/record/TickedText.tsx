/** A `backticked` span or a `[[path:line]]` citation, delimiters included. */
const TICKED = /(`[^`\n]+`|\[\[[^[\]\n]+\]\])/

/**
 * Plain words with their `backticked` spans and [[citations]] read as code —
 * for text that is not markdown but quotes commands and names the way the
 * agent's markdown does: a brief, a done-when check and its evidence.
 * Everything else stays as written. `code` styles the spans for the plane and
 * size they sit on.
 */
export function TickedText({ text, code }: { text: string; code: string }) {
  const parts = text.split(TICKED)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className={code} data-ticked-code>
            {part.startsWith('[[') ? part.slice(2, -2) : part.slice(1, -1)}
          </code>
        ) : (
          part
        )
      )}
    </>
  )
}
