/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '../../../src/renderer/src')

describe('offline queue single owner', () => {
  it('ChatView and SessionChatColumn do not mount useOfflineSendQueue', () => {
    const chatView = readFileSync(join(root, 'features/chat/ChatView.tsx'), 'utf8')
    const column = readFileSync(join(root, 'features/chat/SessionChatColumn.tsx'), 'utf8')
    const app = readFileSync(join(root, 'app/App.tsx'), 'utf8')

    expect(chatView).not.toMatch(/useOfflineSendQueue/)
    expect(column).not.toMatch(/useOfflineSendQueue/)
    expect(app).toMatch(/useOfflineSendQueue/)
  })
})
