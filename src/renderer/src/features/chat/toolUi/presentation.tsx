import { createElement } from 'react'
import { useFullToolContent } from '../components/useFullToolContent'
import type { ToolBodyContext } from './types'
import { getToolBody } from './registry'
import { isProminentPresentation } from './meta'
import { isFileReadTool, wrapFamilyShell } from './shells'

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
    inGroup,
    timing
  } = context
  // Full content loads only while the body is visible (ExpandPanel open or card expanded).
  // File reads never pull the full model payload into the transcript — preview is clamped.
  const enabled =
    tool.contentTruncated === true && expanded === true && !isFileReadTool(tool.name)
  const { loading, failed } = useFullToolContent(tool, enabled, onLoadFullContent)
  const body = createElement(getToolBody(tool.name), {
    tool,
    expanded,
    toolProgress,
    onLoadFullContent,
    loading,
    loadFailed: failed,
    mcpServerNames,
    inGroup,
    timing
  })
  // Bordered ToolCard already provides chrome for prominent tools.
  if (isProminentPresentation(tool)) return body
  return wrapFamilyShell(tool.name, body)
}
