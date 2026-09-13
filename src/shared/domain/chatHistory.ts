import type { ChatMessage } from '../ipc'

export function appendAssistantWithTools(
  messages: ChatMessage[],
  content: string,
  toolCalls?: Array<{ id: string; name: string; arguments: string }>,
  thinking?: string,
  reasoningState?: unknown
): ChatMessage[] {
  const assistant: ChatMessage = { role: 'assistant', content }
  if (thinking) assistant.thinking = thinking
  if (reasoningState !== undefined) assistant.reasoningState = reasoningState
  if (toolCalls?.length) assistant.toolCalls = toolCalls
  return [...messages, assistant]
}

export function appendToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  name: string,
  content: string,
  ok?: boolean
): ChatMessage[] {
  return [
    ...messages,
    {
      role: 'tool',
      toolCallId,
      toolName: name,
      content,
      ...(ok !== undefined ? { ok } : {})
    }
  ]
}

export function messagesForNextTurn(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== 'system')
}
