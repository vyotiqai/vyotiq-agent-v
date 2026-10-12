import type { ToolApprovalMode } from '@shared/ipc'
import { RadioList } from '@renderer/lib/ui'

type ModeCopy = { mode: ToolApprovalMode; label: string; description: string }

/**
 * The three approval modes, named as Settings' "Ask before" names them. "Nothing" is not "nothing asks",
 * so its description says what still does: with approvals off, tools the agent writes for itself still ask, so do shell commands the
 * command guard stops (main/agent/tools/dangerousCommand.ts), and so do MCP
 * server tools while MCP protection is on (Settings → Agent).
 */
export function approvalModes(mcpProtection: boolean): ModeCopy[] {
  return [
    { mode: 'mutating', label: 'Edits and commands', description: 'Recommended. Reading is free; changing things asks first.' },
    { mode: 'all', label: 'Every tool', description: 'Even reads and searches ask.' },
    {
      mode: 'off',
      label: 'Nothing',
      description: mcpProtection
        ? 'For runs nobody is watching. MCP tools, tools the agent writes and risky commands still ask.'
        : 'For runs nobody is watching. Tools the agent writes and risky commands still ask.'
    }
  ]
}

/** What needs your OK: one radio per approval mode, the chosen row filled. */
export function ApprovalModeChoice({
  value,
  onChange,
  mcpProtection = true,
  label = 'What needs your OK'
}: {
  value: ToolApprovalMode
  onChange: (mode: ToolApprovalMode) => void
  mcpProtection?: boolean
  label?: string
}) {
  return (
    <RadioList
      label={label}
      value={value}
      onChange={onChange}
      choices={approvalModes(mcpProtection).map((m) => ({ value: m.mode, label: m.label, description: m.description }))}
    />
  )
}
