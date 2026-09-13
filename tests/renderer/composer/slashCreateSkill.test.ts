import { describe, expect, it, vi } from 'vitest'
import { executeSlashResolveResult } from '@renderer/features/chat/components/composer/slashCommandExecute'

describe('slashCommandExecute create-skill', () => {
  it('forwards create_skill trailing text to onCreateSkill', async () => {
    const onCreateSkill = vi.fn(async () => true)
    const status = await executeSlashResolveResult(
      {
        action: 'client',
        clientAction: 'create_skill',
        trailingText: 'personal notes'
      },
      { onCreateSkill }
    )
    expect(status).toBe('handled')
    expect(onCreateSkill).toHaveBeenCalledWith('personal notes')
  })
})
