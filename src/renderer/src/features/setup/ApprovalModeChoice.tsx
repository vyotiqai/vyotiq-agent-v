import type { ToolApprovalMode } from '@shared/ipc'
import { RadioList } from '@renderer/lib/ui'

type ModeCopy = { mode: ToolApprovalMode; label: string; description: string }

/**
 * The three approval modes in the words Set up uses. "Unattended" is not "nothing asks": with approvals off,
 * tools the agent writes for itself still ask, and so do MCP server tools
 * while MCP protection is on (Settings → Agent).
 */
export function approvalModes(mcpProtection: boolean): ModeCopy[] {
  return [
    { mode: 'mutating', label: 'Edits and commands', description: 'Recommended. Reading is free; changing things asks first.' },
    { mode: 'all', label: 'Every tool', description: 'Even reads and searches ask.' },
    {
      mode: 'off',
      label: 'Unattended',
      description: mcpProtection
        ? 'For runs nobody is watching. MCP tools and tools the agent writes still ask.'
        : 'For runs nobody is watching. Tools the agent writes still ask.'
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
