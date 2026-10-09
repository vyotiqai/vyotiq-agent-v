import { describe, expect, it, vi } from 'vitest'
import { executeSlashResolveResult } from '@renderer/features/chat/components/composer/slashCommandExecute'

describe('slashCommandExecute notices and help', () => {
  it('shows a notice and keeps the draft instead of sending it', async () => {
    const onNotice = vi.fn()
    const status = await executeSlashResolveResult(
      { action: 'notice', message: 'Loop interval must be at least 30s.' },
      { onNotice }
    )
    // 'failed' is the outcome that leaves the draft in place for a fix.
    expect(status).toBe('failed')
    expect(onNotice).toHaveBeenCalledWith('Loop interval must be at least 30s.')
  })

  it('reopens the slash menu for /help', async () => {
    const onHelp = vi.fn()
    const status = await executeSlashResolveResult(
      { action: 'client', clientAction: 'help' },
      { onHelp }
    )
    expect(status).toBe('handled')
    expect(onHelp).toHaveBeenCalledOnce()
  })
})
