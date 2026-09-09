import {
  listMemoryNotes,
  readMemoryFile,
  writeMemoryFile
} from '../context/memory'

export function toolMemoryList(workspace: string): string {
  // index.md is auto-injected into the system prompt every step — do not
  // duplicate it here. memory_read fetches the full file on demand.
  const { notes, indexedNotes, hasState } = listMemoryNotes(workspace)
  // Drift signal: notes on disk vs notes the injected index points at.
  // Unindexed notes are invisible to retrieval (the index is the map);
  // broken pointers would make memory_read fail. Zero injection cost —
  // this output only exists when the agent calls memory_list.
  const unindexed = notes.filter((n) => !indexedNotes.includes(n))
  const broken = indexedNotes.filter((n) => !notes.includes(n))
  const drift: string[] = []
  if (unindexed.length) {
    drift.push(`not in index.md: ${unindexed.join(', ')}`)
  }
  if (broken.length) {
    drift.push(`indexed but missing on disk: ${broken.join(', ')}`)
  }
  return [
    '## notes/',
    notes.length ? notes.map((n) => `- ${n}`).join('\n') : '(none)',
    '',
    `index.md coverage: ${indexedNotes.length}/${notes.length} notes${drift.length ? ` (${drift.join('; ')})` : ' — full'}`,
    `state.md: ${hasState ? 'present' : 'absent'}`,
    '',
    'index.md is pre-injected into the system prompt (memory_read index.md for the full file).'
  ].join('\n')
}

export function toolMemoryRead(workspace: string, pathArg: string): string {
  const cleaned = pathArg.trim().replace(/^[/\\]+/, '')
  if (!cleaned) throw new Error('path is required')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  // Allow index.md, state.md, notes/foo.md
  if (
    cleaned !== 'index.md' &&
    cleaned !== 'state.md' &&
    !cleaned.startsWith('notes/')
  ) {
    throw new Error('path must be index.md, state.md, or notes/<name>.md')
  }
  if (cleaned.startsWith('notes/')) {
    const noteName = cleaned.slice('notes/'.length)
    if (!noteName || !/^[a-zA-Z0-9._-]+\.md$/.test(noteName)) {
      throw new Error('note files must be notes/<name>.md with safe characters')
    }
  }
  return readMemoryFile(workspace, cleaned)
}

/** @deprecated Kept for callers that still import the former write cap. */
export const MEMORY_WRITE_CAP = Number.POSITIVE_INFINITY

export function toolMemoryWrite(
  workspace: string,
  pathArg: string,
  contents: string
): string {
  const cleaned = pathArg.trim().replace(/^[/\\]+/, '')
  if (!cleaned) throw new Error('path is required')
  if (cleaned.includes('..')) throw new Error('Invalid memory path')
  if (
    cleaned !== 'index.md' &&
    cleaned !== 'state.md' &&
    !cleaned.startsWith('notes/')
  ) {
    throw new Error('path must be index.md, state.md, or notes/<name>.md')
  }
  if (cleaned.startsWith('notes/')) {
    const noteName = cleaned.slice('notes/'.length)
    if (!noteName || !/^[a-zA-Z0-9._-]+\.md$/.test(noteName)) {
      throw new Error('note files must be notes/<name>.md with safe characters')
    }
  }
  const written = writeMemoryFile(workspace, cleaned, contents)
  return `Wrote memory/${written}`
}
