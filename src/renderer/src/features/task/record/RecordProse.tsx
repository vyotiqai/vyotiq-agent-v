import { useId } from 'react'
import { MarkdownContent } from '@renderer/lib/ui'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'

/** A `[text](#fragment)` link that is not one of the autolinked `#vy-file:` paths. */
const FRAGMENT_LINK = /\]\(#(?!vy-file:)[^)\s]+\)/

/**
 * What the agent wrote into the record — a note between calls, a run's Result.
 * A workspace path in it (`src/foo.ts`, `src/foo.ts:42`, bare or in backticks)
 * opens that file in the Files tab, at the line, through the same
 * `onOpenWorkspaceFile` the tool rows use. Headings get ids only when the text
 * links to one of its own sections (a table of contents), scoped to this body
 * so two notes with the same heading never share an id.
 */
export function RecordProse({
  text,
  streaming = false,
  size,
  tone
}: {
  text: string
  streaming?: boolean
  size?: 'sm' | 'md'
  tone?: 'secondary' | 'strong'
}) {
  const { onOpenWorkspaceFile } = useRunSession()
  const scope = useId()
  return (
    <MarkdownContent
      content={text}
      streaming={streaming}
      size={size}
      tone={tone}
      linkWorkspacePaths={Boolean(onOpenWorkspaceFile)}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      headingIds={FRAGMENT_LINK.test(text)}
      headingIdScope={scope}
    />
  )
}
