/**
 * Notes the agent loop appends to a tool's result for the model, never for
 * the person reading the record (main `executeStepTools.ts`):
 *
 * - `[Soft warning: …]` — an edit made without diagnostics, or without
 *   reading the file first;
 * - `[Note: <path> was already read … Re-read only if you expect it changed.]`;
 * - `<workspace_instructions …>…</workspace_instructions>` — a nested rules
 *   file attached to a read or an edit under it.
 *
 * Each is appended after a blank line. Shown, they read as part of the tool's
 * output: a delete said "Deleted a.ts [Soft warning: this step mutated
 * file(s) without calling diagnostics…]".
 */
const MODEL_NOTES: readonly RegExp[] = [
  /\n\n\[Soft warning: [^\n]*\]/g,
  /\n\n\[Note: [^\n]* was already read [^\n]*\]/g,
  /\n\n<workspace_instructions\b[\s\S]*?<\/workspace_instructions>/g
]

/** A tool result as the reader should see it: without the notes meant for the model. */
export function stripModelNotes(content: string): string
export function stripModelNotes(content: string | undefined): string | undefined
export function stripModelNotes(content: string | undefined): string | undefined {
  if (!content) return content
  let out = content
  for (const note of MODEL_NOTES) out = out.replace(note, '')
  return out
}
