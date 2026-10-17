import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { assembleContext, clearSystemPromptCache } from '@main/agent/context/assemble'
import { VOICE_REPLY_TEXT } from '@main/agent/context/userRules'
import { setVoiceReplyWorkspace } from '@main/voice/voiceReply'
import type { ChatMessage, ModelInfo } from '@shared/ipc'

/**
 * 2026-10-17 live run c79e6792: "System prompt sections cut to fit the system
 * budget" when its prompt was built. The voice instructions rode inside the
 * response-style slot, capped at 5% of the system budget (768 tokens of a
 * ~2,000-token block), so the agent never saw the app_control action list or
 * the rules after it: it called app_control list to find out, told the person
 * there was no setting it could reach, and said "Okay" to "keep quiet" without
 * muting anything.
 */
const model: ModelInfo = {
  id: 'test',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  contextWindow: 200_000
}

const harness = readFileSync(join(__dirname, '../../../resources/harness/default.md'), 'utf8')
const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i % 97}`).join(' ')

afterEach(() => setVoiceReplyWorkspace('vp', null))

describe('voice_reply survives the system budget', () => {
  it('keeps every line of the voice instructions, the action list included', async () => {
    clearSystemPromptCache()
    setVoiceReplyWorkspace('vp', '/repo')
    const messages: ChatMessage[] = [{ role: 'user', content: 'Okay, keep quiet.', spoken: true }]
    const result = await assembleContext({
      harness,
      messages,
      workspacePath: '/repo',
      memorySection: '',
      goal: 'voice',
      model,
      toolsJsonEstimate: 1_000,
      providerId: 'ollama',
      skillsSection: `<available_skills>\n${words(2500)}\n</available_skills>`,
      mcpSection: `<mcp_servers>\n${words(1500)}\n</mcp_servers>`,
      tone: 'friendly',
      userRules: [{ id: 'r', text: words(400) }] as never
    })
    const lastLine = VOICE_REPLY_TEXT.split('\n').at(-1) ?? ''
    expect(result.system).toContain('You are Agent V')
    expect(result.system).toContain('call it at once when they ask')
    expect(result.system).toContain(lastLine)
  })
})
