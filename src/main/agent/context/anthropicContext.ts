/**
 * Anthropic native context options. Server-side clear_tool_uses and compact
 * edits are disabled — LLM summarization is the only shrink path. Prompt
 * caching still uses enableContextManagement=false so no context edits are sent.
 */
export function anthropicNativeOptions(): {
  enableContextManagement: boolean
} {
  return { enableContextManagement: false }
}
