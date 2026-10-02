import { createElement, useMemo } from 'react'
import type { UiToolRow } from '@shared/transcript'
import { stripModelNotes } from '@shared/utils/modelNotes'
import { useFullToolContent } from '../components/useFullToolContent'
import type { ToolBodyContext } from './types'
import { getToolBody } from './registry'
import { isProminentPresentation } from './meta'
import { isFileReadTool, wrapFamilyShell } from './shells'

/**
 * The tool as the reader sees it: its result without the notes the loop
 * appends for the model ("[Soft warning: …]"). Whether it has a body is
 * decided on this too — a delete's warning was all that gave it one.
 */
export function readerTool(tool: UiToolRow): UiToolRow {
  const content = stripModelNotes(tool.content)
  return content === tool.content ? tool : { ...tool, content }
}

export function ToolBodyView({
  context
}: {
  context: ToolBodyContext
}) {
  const {
    tool,
    expanded,
    onLoadFullContent,
    toolProgress,
    mcpServerNames,
    inGroup
  } = context
  // Full content loads only while the body is visible (ExpandPanel open or card expanded).
  // File reads never pull the full model payload into the transcript — preview is clamped.
  const enabled =
    tool.contentTruncated === true && expanded === true && !isFileReadTool(tool.name)
  const { loading, failed } = useFullToolContent(tool, enabled, onLoadFullContent)
  const shown = useMemo(() => readerTool(tool), [tool])
  const body = createElement(getToolBody(tool.name), {
    tool: shown,
    expanded,
    toolProgress,
    onLoadFullContent,
    loading,
    loadFailed: failed,
    mcpServerNames,
    inGroup
  })
  // Bordered ToolCard already provides chrome for prominent tools.
  if (isProminentPresentation(tool)) return body
  return wrapFamilyShell(tool.name, body)
}
