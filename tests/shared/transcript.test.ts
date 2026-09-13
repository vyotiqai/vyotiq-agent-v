import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import { inferToolStatus, messagesToUiItems, applyEventTimestamps, applyCompactionItems, insertCompactionItem, applyPersistedLiveTools, finalizeHydratedTranscript, isMeaningfulThinking, shouldRenderThinking, duplicatesReasoning, mergeThinkingContent, applyThinkingSnapshot, stripToolShapedAssistantText, stripToolShapedAssistantTextForStream, stripIncompleteToolPrefix, isToolShapedTextLeak, scrubStreamingAssistantToolLeak, type UiItem } from '@shared/transcript'

describe('messagesToUiItems', () => {
  it('never renders loop-injected synthetic user messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'real prompt' },
      {
        role: 'user',
        content: '[Goal continue] Continue the active goal until it is complete.',
        synthetic: true
      },
      { role: 'assistant', content: 'working' }
    ]

    const items = messagesToUiItems(messages)
    expect(items).toHaveLength(2)
    expect(
      items.some(
        (i) =>
          i.kind === 'message' && i.role === 'user' && String(i.content).includes('Goal continue')
      )
    ).toBe(false)
  })

  it('rebuilds user, assistant, and tool rows in order', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read a.ts' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'file body' },
      { role: 'assistant', content: 'done' }
    ]

    const items = messagesToUiItems(messages)
    expect(items.map((i) => i.kind)).toEqual(['message', 'tool', 'message'])
    const tool = items[1]
    expect(tool.kind).toBe('tool')
    if (tool.kind === 'tool') {
      expect(tool.tool.name).toBe('read')
      expect(tool.tool.summary).toBe('a.ts')
      expect(tool.tool.status).toBe('done')
      expect(tool.tool.content).toBe('file body')
    }
  })

  it('includes thinking on assistant messages', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'answer', thinking: 'planned approach' }
    ]
    const items = messagesToUiItems(messages)
    expect(items).toHaveLength(1)
    if (items[0].kind === 'message') {
      expect(items[0].thinking).toBe('planned approach')
    }
  })

  it('derives thinking from reasoningState when the thinking field is absent', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: 'answer',
        reasoningState: { kind: 'openai_compat', reasoningContent: 'derived view' }
      }
    ] as ChatMessage[])
    expect(items).toHaveLength(1)
    if (items[0].kind === 'message') {
      expect(items[0].thinking).toBe('derived view')
    }
  })

  it('copies persisted user send timestamps onto UI items', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'hello', at: '2026-07-24T12:00:00.000Z' }
    ])
    expect(items).toHaveLength(1)
    if (items[0]?.kind === 'message') {
      expect(items[0].at).toBe('2026-07-24T12:00:00.000Z')
    }
  })

  it('keeps each step reasoning above the calls it explains', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'refactor' },
      {
        role: 'assistant',
        content: '',
        thinking: 'First I read the file.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'body' },
      {
        role: 'assistant',
        content: '',
        thinking: 'Now I edit it.',
        toolCalls: [{ id: 'c2', name: 'edit', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c2', toolName: 'edit', content: 'ok' },
      { role: 'assistant', content: 'Refactored.' }
    ]

    const items = messagesToUiItems(messages)
    expect(items.map((i) => i.kind)).toEqual([
      'message',
      'message',
      'tool',
      'message',
      'tool',
      'message'
    ])
    expect(items[1]).toMatchObject({ thinking: 'First I read the file.', content: '' })
    expect(items[3]).toMatchObject({ thinking: 'Now I edit it.', content: '' })
    expect(items[5]).toMatchObject({ content: 'Refactored.' })
  })

  it('marks empty tool results as done when replaying a run', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"empty.txt"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: '' }
    ]
    const items = messagesToUiItems(messages)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('tool')
    if (items[0].kind === 'tool') {
      expect(items[0].tool.status).toBe('done')
    }
  })

  it('skips empty assistant bubble when only tool calls', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'search', arguments: '{"query":"foo"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'search', content: 'hits' }
    ]
    const items = messagesToUiItems(messages)
    expect(items).toHaveLength(1)
    expect(items[0].kind).toBe('tool')
  })

  it('places assistant text before tools in the same turn', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read file' },
      {
        role: 'assistant',
        content: 'I will read that file for you.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'file body' }
    ]

    const items = messagesToUiItems(messages)
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'tool'])
    expect(items[0]).toMatchObject({ kind: 'message', role: 'user' })
    expect(items[1]).toMatchObject({
      kind: 'message',
      role: 'assistant',
      content: 'I will read that file for you.'
    })
  })

  it('passes image URLs through user messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', url: 'data:image/png;base64,abc' }
        ]
      }
    ]

    const items = messagesToUiItems(messages)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      content: 'look at this',
      images: ['data:image/png;base64,abc']
    })
  })

  it('uses stable message ids across rebuilds', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    const a = messagesToUiItems(messages)
    const b = messagesToUiItems(messages)
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id))
    expect(a[0]?.id).toBe('user-0')
    expect(a[1]?.id).toBe('assistant-1')
  })

  it('emits running tool rows for unresolved toolCalls', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c-pending', name: 'read', arguments: '{"path":"a.ts"}' }]
      }
    ]
    const items = messagesToUiItems(messages)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'tool',
      id: 'c-pending',
      tool: { name: 'read', status: 'running', summary: 'a.ts' }
    })
  })

  it('stores raw JSON in argsPreview when rebuilding from messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Reading.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'body' }
    ]
    const items = messagesToUiItems(messages)
    const tool = items.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.summary).toBe('a.ts')
      expect(tool.tool.argsPreview).toBe('{"path":"a.ts"}')
    }
  })

  it('interleaves multi-step assistant text and tools instead of stacking tools at the end', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'analyze' },
      {
        role: 'assistant',
        content: 'Reading configs.',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'a' },
      { role: 'tool', toolCallId: 'c2', toolName: 'read', content: 'b' },
      {
        role: 'assistant',
        content: 'Exploring sources.',
        toolCalls: [{ id: 'c3', name: 'search', arguments: '{"query":".kt"}' }]
      },
      { role: 'tool', toolCallId: 'c3', toolName: 'search', content: 'hits' }
    ]
    const items = messagesToUiItems(messages)
    expect(items.map((i) => i.kind)).toEqual([
      'message',
      'message',
      'tool',
      'tool',
      'message',
      'tool'
    ])
    expect(items[1]).toMatchObject({ content: 'Reading configs.' })
    expect(items[2]).toMatchObject({ id: 'c1', tool: { status: 'done' } })
    expect(items[3]).toMatchObject({ id: 'c2', tool: { status: 'done' } })
    expect(items[4]).toMatchObject({ content: 'Exploring sources.' })
    expect(items[5]).toMatchObject({ id: 'c3', tool: { status: 'done' } })
  })

})

describe('transcript display helpers', () => {
  it('treats placeholder punctuation as non-meaningful thinking', () => {
    expect(isMeaningfulThinking('.')).toBe(false)
    expect(isMeaningfulThinking('…')).toBe(false)
    expect(isMeaningfulThinking('planned approach')).toBe(true)
  })

  it('hides short finished thinking that would leave empty transcript gaps', () => {
    expect(shouldRenderThinking('OK')).toBe(false)
    expect(shouldRenderThinking('planned approach')).toBe(false)
    expect(shouldRenderThinking('Let me reason about this carefully.')).toBe(true)
    expect(shouldRenderThinking('OK', true)).toBe(true)
  })

  it('keeps narration between tool batches, streaming or not', () => {
    const narration = {
      kind: 'message',
      id: 'a2',
      role: 'assistant',
      content: 'Continuing the audit in the router next.'
    } as const

    expect(duplicatesReasoning(narration)).toBe(false)
    expect(duplicatesReasoning({ ...narration, streaming: true })).toBe(false)
  })

  it('hides text that repeats the opening of reasoning verbatim', () => {
    const passage = 'The router builds its table before the first request arrives.'

    expect(
      duplicatesReasoning({
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: passage,
        thinking: `${passage}\n\nNow I will verify the handlers.`
      })
    ).toBe(true)
  })

  it('keeps an answer that only appears later inside reasoning', () => {
    const passage = 'The router builds its table before the first request arrives.'

    expect(
      duplicatesReasoning({
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: passage,
        thinking: `Let me check.\n\n${passage}`
      })
    ).toBe(false)
  })

  it('does not treat a shared phrase as a duplicate', () => {
    expect(
      duplicatesReasoning({
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Done.',
        thinking: 'Done. Now I will summarize what changed for the reader.'
      })
    ).toBe(false)
  })

  it('drops duplicate paragraphs when merging thinking chunks', () => {
    const repeated =
      'Good, I have a comprehensive view of the codebase. Now I will summarize findings.'
    const merged = mergeThinkingContent([
      `First pass.\n\n${repeated}`,
      `${repeated}\n\nSecond pass.`
    ])
    expect(merged).toBe(`First pass.\n\n${repeated}\n\nSecond pass.`)
  })

  it('replaces streamed thinking with a provider snapshot', () => {
    expect(applyThinkingSnapshot('AB', 'ABC')).toBe('ABC')
    expect(applyThinkingSnapshot('ABC', 'ABC')).toBe('ABC')
    expect(applyThinkingSnapshot('already streamed', '')).toBe('already streamed')
    expect(applyThinkingSnapshot('already streamed', undefined)).toBe('already streamed')
    expect(applyThinkingSnapshot(undefined, 'only snapshot')).toBe('only snapshot')
  })
})

describe('stripToolShapedAssistantText', () => {
  it('removes a leaked tool JSON blob from assistant text', () => {
    expect(
      stripToolShapedAssistantText(
        'tool {"edits":[{"path":"api/page.tsx","contents":"\\"use client\\";"}]}\nNow I have the COMPLETE picture.'
      )
    ).toBe('Now I have the COMPLETE picture.')
  })

  it('drops a message that is only a tool dump', () => {
    expect(stripToolShapedAssistantText('tool {"path":"a.ts","contents":"x"}')).toBe('')
  })

  it('leaves ordinary narration alone', () => {
    expect(stripToolShapedAssistantText('The tool ran successfully.')).toBe(
      'The tool ran successfully.'
    )
  })

  it('removes leaked pseudo tool call lines', () => {
    expect(
      stripToolShapedAssistantText(
        'tool read src/a.ts\ntool glob **/*.tsx\n\nHere is what I found.'
      )
    ).toBe('Here is what I found.')
  })

  it('removes DeepSeek DSML tool_calls blocks (fullwidth pipes from V4 encoding docs)', () => {
    const fw = '\uFF5C'
    const block =
      `Good — the CSS foundation is solid.\n` +
      `<${fw}DSML${fw}tool_calls>\n` +
      `<${fw}DSML${fw}invoke name="edit">\n` +
      `<${fw}DSML${fw}parameter name="edits" string="false">[{"path":"layout.tsx"}]</${fw}DSML${fw}parameter>\n` +
      `</${fw}DSML${fw}invoke>\n` +
      `</${fw}DSML${fw}tool_calls>`
    expect(stripToolShapedAssistantText(block)).toBe('Good — the CSS foundation is solid.')
  })

  it('removes DSML markup with ASCII pipes as shown in the live UI', () => {
    const leaked =
      'Let me fix the remaining files.\n' +
      '<|DSML|tool_calls><|DSML|invoke name="edit">' +
      '<|DSML|parameter name="edits" string="false">[{"path":"a.tsx"}]</|DSML|parameter>' +
      '</|DSML|invoke></|DSML|tool_calls>'
    expect(stripToolShapedAssistantText(leaked)).toBe('Let me fix the remaining files.')
  })
})

describe('stripToolShapedAssistantTextForStream', () => {
  it('hides an in-progress tool JSON blob at the end of the buffer', () => {
    expect(stripToolShapedAssistantTextForStream('Checking routes.\ntool {"path":"a.ts"')).toBe(
      'Checking routes.'
    )
  })

  it('strips complete blobs and trailing incomplete prefixes together', () => {
    expect(
      stripToolShapedAssistantTextForStream(
        'tool {"path":"a.ts"}\nNow reading.\ntool {"path":"b.ts"'
      )
    ).toBe('Now reading.')
  })

  it('leaves ordinary narration alone', () => {
    expect(stripToolShapedAssistantTextForStream('The tool ran successfully.')).toBe(
      'The tool ran successfully.'
    )
  })

  it('hides an in-progress DSML tool_calls block while streaming', () => {
    expect(
      stripToolShapedAssistantTextForStream(
        'Applying edits.\n<|DSML|tool_calls>\n<|DSML|invoke name="edit">'
      )
    ).toBe('Applying edits.')
  })
})

describe('isToolShapedTextLeak', () => {
  it('detects leaked tool JSON and pseudo calls', () => {
    expect(isToolShapedTextLeak('tool {"path":"a.ts"}')).toBe(true)
    expect(isToolShapedTextLeak('tool read src/a.ts')).toBe(true)
    expect(isToolShapedTextLeak('The tool ran successfully.')).toBe(false)
  })

  it('detects a buffer that is only tool-shaped leak after stripping', () => {
    expect(isToolShapedTextLeak('\n\ntool {"path":"a.ts"}\n')).toBe(true)
    expect(isToolShapedTextLeak('tool {"a":1}\ntool read x.ts')).toBe(true)
  })

  it('detects a buffer that is only DSML markup', () => {
    expect(
      isToolShapedTextLeak(
        '<|DSML|tool_calls><|DSML|invoke name="edit"></|DSML|invoke></|DSML|tool_calls>'
      )
    ).toBe(true)
  })
})

describe('stripIncompleteToolPrefix', () => {
  it('drops a trailing partial pseudo tool line', () => {
    expect(stripIncompleteToolPrefix('Summary so far.\ntool read src/a.ts')).toBe('Summary so far.')
  })

  it('drops a trailing bare tool prefix', () => {
    expect(stripIncompleteToolPrefix('Summary so far.\ntool ')).toBe('Summary so far.')
  })
})

describe('scrubStreamingAssistantToolLeak', () => {
  it('strips leaked tool JSON from streaming assistant rows', () => {
    const items = scrubStreamingAssistantToolLeak([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Checking routes.\ntool {"path":"a.ts"',
        streaming: true
      },
      {
        kind: 'message',
        id: 'a2',
        role: 'assistant',
        content: 'done',
        streaming: false
      }
    ])
    const streaming = items.find((i) => i.kind === 'message' && i.id === 'a1')
    expect(streaming?.kind === 'message' ? streaming.content : null).toBe('Checking routes.')
  })
})

describe('inferToolStatus', () => {
  it('marks failures from content heuristics', () => {
    expect(inferToolStatus('Unknown tool: foo')).toBe('fail')
    expect(inferToolStatus('exit_code: 1\nstderr')).toBe('fail')
    expect(inferToolStatus('ok output')).toBe('done')
  })

  it('treats empty tool output as success when replaying history', () => {
    expect(inferToolStatus('')).toBe('done')
    expect(inferToolStatus('Cancelled')).toBe('fail')
    expect(inferToolStatus('Interrupted')).toBe('fail')
    expect(inferToolStatus('Stopped')).toBe('fail')
    expect(inferToolStatus('Not completed')).toBe('fail')
    expect(inferToolStatus('Connection lost')).toBe('fail')
    expect(inferToolStatus('Failed to parse tool arguments')).toBe('fail')
    expect(inferToolStatus('exit_code: 0')).toBe('done')
  })

  it('prefers explicit ok flag over content heuristics', () => {
    expect(inferToolStatus('exit_code: 1\nstderr', true)).toBe('done')
    expect(inferToolStatus('ok output', false)).toBe('fail')
  })
})

describe('applyEventTimestamps', () => {
  it('attaches tool_start timestamps to tool rows in order', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'ok' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'file'
        }
      }
    ])
    const tool = enriched.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.at).toBe('2026-07-24T12:00:00.000Z')
    }
  })

  it('reconstructs group timing and ok status from persisted events', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'fail output' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts'
        }
      },
      {
        at: '2026-07-24T12:00:02.000Z',
        event: {
          type: 'tool_result',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts',
          ok: false,
          content: 'fail output'
        }
      }
    ])
    const tool = enriched.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.status).toBe('fail')
      expect(tool.groupTiming?.startedAt).toBe(new Date('2026-07-24T12:00:00.000Z').getTime())
      expect(tool.groupTiming?.endedAt).toBe(new Date('2026-07-24T12:00:02.000Z').getTime())
    }
  })

  it('prefers the last tool_result ok flag when duplicates exist for one toolCallId', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'ok' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts'
        }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: {
          type: 'tool_result',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts',
          ok: false,
          content: 'first fail'
        }
      },
      {
        at: '2026-07-24T12:00:02.000Z',
        event: {
          type: 'tool_result',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts',
          ok: true,
          content: 'retry ok'
        }
      }
    ])
    const tool = enriched.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.status).toBe('done')
    }
  })

  it('matches tool_start timestamps by toolCallId, not row order', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{}' },
          { id: 'c2', name: 'search', arguments: '{}' }
        ]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'a' },
      { role: 'tool', toolCallId: 'c2', toolName: 'search', content: 'b' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:05.000Z',
        event: {
          type: 'status',
          runId: 'r1',
          status: 'running'
        }
      },
      {
        at: '2026-07-24T12:00:10.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c2',
          name: 'search',
          summary: 'query'
        }
      },
      {
        at: '2026-07-24T12:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts'
        }
      }
    ])
    const tools = enriched.filter((i) => i.kind === 'tool')
    expect(tools[0]?.kind).toBe('tool')
    expect(tools[1]?.kind).toBe('tool')
    if (tools[0]?.kind === 'tool' && tools[1]?.kind === 'tool') {
      expect(tools[0].at).toBe('2026-07-24T12:00:00.000Z')
      expect(tools[1].at).toBe('2026-07-24T12:00:10.000Z')
    }
  })

  it('attaches user and assistant message timestamps from run events', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:05.000Z',
        event: { type: 'status', runId: 'r1', status: 'done' }
      }
    ])
    const user = enriched.find((i) => i.kind === 'message' && i.role === 'user')
    const assistant = enriched.find((i) => i.kind === 'message' && i.role === 'assistant')
    expect(user?.kind).toBe('message')
    expect(assistant?.kind).toBe('message')
    if (user?.kind === 'message') expect(user.at).toBe('2026-07-24T12:00:00.000Z')
    if (assistant?.kind === 'message') expect(assistant.at).toBe('2026-07-24T12:00:05.000Z')
  })

  it('aligns follow-up user timestamps with the next invoke running status', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'ok' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: '' }
      },
      {
        at: '2026-07-24T12:00:04.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'done' }
      },
      {
        at: '2026-07-24T12:00:05.000Z',
        event: { type: 'status', runId: 'r1', status: 'done' }
      },
      {
        at: '2026-07-24T17:00:05.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      }
    ])
    const users = enriched.filter((i) => i.kind === 'message' && i.role === 'user')
    expect(users[0]?.kind).toBe('message')
    expect(users[1]?.kind).toBe('message')
    if (users[0]?.kind === 'message') expect(users[0].at).toBe('2026-07-24T12:00:00.000Z')
    if (users[1]?.kind === 'message') expect(users[1].at).toBe('2026-07-24T17:00:05.000Z')
  })

  it('does not count idle time between turns as follow-up work', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'ok' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:05.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'done' }
      },
      {
        at: '2026-07-24T12:00:06.000Z',
        event: { type: 'status', runId: 'r1', status: 'done' }
      },
      {
        at: '2026-07-24T17:00:06.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T17:05:55.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'ok' }
      }
    ])
    const users = enriched.filter((i) => i.kind === 'message' && i.role === 'user')
    const assistants = enriched.filter((i) => i.kind === 'message' && i.role === 'assistant')
    expect(users[1]?.kind).toBe('message')
    expect(assistants[1]?.kind).toBe('message')
    if (users[1]?.kind === 'message' && assistants[1]?.kind === 'message') {
      expect(users[1].at).toBe('2026-07-24T17:00:06.000Z')
      expect(assistants[1].at).toBe('2026-07-24T17:05:55.000Z')
      expect(
        new Date(assistants[1].at!).getTime() - new Date(users[1].at!).getTime()
      ).toBe(5 * 60_000 + 49_000)
    }
  })

  it('uses follow_up_applied time for mid-run follow-up user timestamps', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'working' },
      { role: 'user', content: 'also this' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:04.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'working' }
      },
      {
        at: '2026-07-24T12:00:10.000Z',
        event: {
          type: 'follow_up_applied',
          runId: 'r1',
          ids: ['fu-1'],
          messages: [{ role: 'user', content: 'also this' }]
        }
      }
    ])
    const users = enriched.filter((i) => i.kind === 'message' && i.role === 'user')
    expect(users[1]?.kind).toBe('message')
    if (users[1]?.kind === 'message') {
      expect(users[1].at).toBe('2026-07-24T12:00:10.000Z')
    }
  })

  it('ignores resume running after cancel when assigning follow-up user timestamps', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: 'second' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:03.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'partial' }
      },
      {
        at: '2026-07-24T12:00:04.000Z',
        event: { type: 'status', runId: 'r1', status: 'cancelled' }
      },
      {
        at: '2026-07-24T12:00:05.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:20.000Z',
        event: { type: 'status', runId: 'r1', status: 'done' }
      },
      {
        at: '2026-07-24T13:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      }
    ])
    const users = enriched.filter((i) => i.kind === 'message' && i.role === 'user')
    expect(users[0]?.kind).toBe('message')
    expect(users[1]?.kind).toBe('message')
    if (users[0]?.kind === 'message') expect(users[0].at).toBe('2026-07-24T12:00:00.000Z')
    if (users[1]?.kind === 'message') expect(users[1].at).toBe('2026-07-24T13:00:00.000Z')
  })

  it('keeps a persisted user send timestamp instead of reconstructing it', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'hello', at: '2026-07-24T11:59:00.000Z' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      }
    ])
    const user = enriched.find((i) => i.kind === 'message' && i.role === 'user')
    expect(user?.kind).toBe('message')
    if (user?.kind === 'message') expect(user.at).toBe('2026-07-24T11:59:00.000Z')
  })

  it('uses assistant_message events for multi-step assistant timestamps', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'step 1' },
      { role: 'assistant', content: 'step 2' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:01.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'step 1' }
      },
      {
        at: '2026-07-24T12:00:04.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'step 2' }
      }
    ])
    const assistants = enriched.filter((i) => i.kind === 'message' && i.role === 'assistant')
    expect(assistants[0]?.kind).toBe('message')
    expect(assistants[1]?.kind).toBe('message')
    if (assistants[0]?.kind === 'message') expect(assistants[0].at).toBe('2026-07-24T12:00:01.000Z')
    if (assistants[1]?.kind === 'message') expect(assistants[1].at).toBe('2026-07-24T12:00:04.000Z')
  })

  it('prefers event timestamps over provisional live values', () => {
    const items: UiItem[] = [
      {
        kind: 'message',
        id: 'assistant-1',
        role: 'assistant',
        content: 'hi',
        at: '2026-07-24T11:00:00.000Z'
      }
    ]
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:05.000Z',
        event: { type: 'assistant_message', runId: 'r1', content: 'hi' }
      }
    ])
    const assistant = enriched[0]
    expect(assistant?.kind).toBe('message')
    if (assistant?.kind === 'message') {
      expect(assistant.at).toBe('2026-07-24T12:00:05.000Z')
    }
  })

  it('uses cancelled status for assistant timestamp fallback', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' }
      },
      {
        at: '2026-07-24T12:00:03.000Z',
        event: { type: 'status', runId: 'r1', status: 'cancelled' }
      }
    ])
    const assistant = enriched.find((i) => i.kind === 'message' && i.role === 'assistant')
    expect(assistant?.kind).toBe('message')
    if (assistant?.kind === 'message') expect(assistant.at).toBe('2026-07-24T12:00:03.000Z')
  })

  it('ignores orphan tool events that do not match transcript rows', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'ok' }
    ])
    const enriched = applyEventTimestamps(items, [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'orphan',
          name: 'search',
          summary: 'query'
        }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: {
          type: 'tool_result',
          runId: 'r1',
          toolCallId: 'orphan',
          name: 'search',
          summary: 'query',
          ok: false,
          content: 'fail'
        }
      },
      {
        at: '2026-07-24T12:00:02.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'file'
        }
      }
    ])
    const tool = enriched.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.at).toBe('2026-07-24T12:00:02.000Z')
      expect(tool.tool.status).toBe('done')
    }
  })






})

describe('applyPersistedLiveTools', () => {
  it('rebuilds running tool chrome from persisted tool_call_delta snapshots', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'go' }])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          argumentsDelta: '{"path":"a.ts"}'
        }
      }
    ]
    const next = applyPersistedLiveTools(items, events)
    const tool = next.find((item) => item.kind === 'tool')
    expect(tool).toMatchObject({
      id: 'c1',
      tool: { name: 'read', status: 'running', argsPreview: '{"path":"a.ts"}' }
    })
  })

  it('accumulates every persisted argument fragment for one tool call', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'go' }])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          argumentsDelta: '{"pa'
        }
      },
      {
        at: '2026-07-28T12:00:00.010Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          argumentsDelta: 'th":"a.ts"}'
        }
      }
    ]
    const tool = applyPersistedLiveTools(items, events).find((item) => item.kind === 'tool')
    expect(tool).toMatchObject({
      id: 'c1',
      tool: { argsPreview: '{"path":"a.ts"}' }
    })
  })

  it('does not duplicate tools already present from messages', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      }
    ])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          argumentsDelta: '{"path":"a.ts"}'
        }
      }
    ]
    const next = applyPersistedLiveTools(items, events)
    expect(next.filter((item) => item.kind === 'tool')).toHaveLength(1)
  })

  it('skips nameless tool_call_delta placeholders', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'go' }])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'pending_0',
          name: 'tool',
          argumentsDelta: '{'
        }
      }
    ]
    expect(applyPersistedLiveTools(items, events).some((item) => item.kind === 'tool')).toBe(false)
  })

  it('drops provisional tool chrome from a prior attempt after stream_reset', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'go' }])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'stale',
          name: 'read',
          argumentsDelta: '{"path":"old.ts"}'
        }
      },
      {
        at: '2026-07-28T12:00:01.000Z',
        event: { type: 'stream_reset' as const, runId: 'r1', step: 1 }
      },
      {
        at: '2026-07-28T12:00:02.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'fresh',
          name: 'grep',
          argumentsDelta: '{"pattern":"x"}'
        }
      }
    ]
    const next = applyPersistedLiveTools(items, events)
    const tools = next.filter((item) => item.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'fresh',
      tool: { name: 'grep', status: 'running' }
    })
  })

  it('drops provisional chrome when assistant_message omits rejected tool_calls', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'go' }])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'orphan-edit',
          name: 'edit',
          argumentsDelta: '{"path":"a.ts"'
        }
      },
      {
        at: '2026-07-28T12:00:01.000Z',
        event: {
          type: 'assistant_message' as const,
          runId: 'r1',
          content: 'retrying edit args'
        }
      }
    ]
    expect(applyPersistedLiveTools(items, events).some((item) => item.kind === 'tool')).toBe(false)
  })

  it('drops live chrome after tool_result even when messages lag', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'go' }])
    const events = [
      {
        at: '2026-07-28T12:00:00.000Z',
        event: {
          type: 'tool_start' as const,
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts'
        }
      },
      {
        at: '2026-07-28T12:00:01.000Z',
        event: {
          type: 'tool_result' as const,
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts',
          ok: true,
          content: 'ok'
        }
      }
    ]
    expect(applyPersistedLiveTools(items, events).some((item) => item.kind === 'tool')).toBe(false)
  })
})

describe('finalizeHydratedTranscript', () => {
  it('marks orphan running tools failed when the run was cancelled', () => {
    const events = [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' as const }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: { type: 'tool_start', runId: 'r1', toolCallId: 'c1', name: 'search' }
      },
      {
        at: '2026-07-24T12:00:03.000Z',
        event: { type: 'status', runId: 'r1', status: 'cancelled' as const }
      }
    ]
    const items = applyEventTimestamps(
      messagesToUiItems([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'search', arguments: '{}' }]
        }
      ]),
      events
    )
    const finalized = finalizeHydratedTranscript(items, events)
    const tool = finalized.find((item) => item.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.status).toBe('fail')
      expect(tool.tool.content).toBe('Cancelled')
    }
  })

  it('cancels in-progress todo items when the run was interrupted', () => {
    const events = [
      {
        at: '2026-07-24T12:00:03.000Z',
        event: { type: 'status', runId: 'r1', status: 'cancelled' as const }
      }
    ]
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/5 complete\n[~] Audit core library files\n[ ] Audit API routes'
      }
    ])
    const finalized = finalizeHydratedTranscript(items, events)
    const tool = finalized.find((item) => item.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.content).toContain('[-] Audit core library files')
      expect(tool.tool.content).not.toContain('[~]')
    }
  })

  it('demotes in-progress todo items to pending when the run completed or errored', () => {
    const content = '0/2 complete\n[~] Ship\n[ ] Docs'
    for (const status of ['done', 'error'] as const) {
      const events = [
        {
          at: '2026-07-24T12:00:03.000Z',
          event: { type: 'status', runId: 'r1', status }
        }
      ]
      const items = messagesToUiItems([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
        },
        {
          role: 'tool',
          toolCallId: 'todo1',
          toolName: 'todo_write',
          content
        }
      ])
      const finalized = finalizeHydratedTranscript(items, events)
      const tool = finalized.find((item) => item.kind === 'tool')
      expect(tool?.kind).toBe('tool')
      if (tool?.kind === 'tool') {
        expect(tool.tool.content).toContain('[ ] Ship')
        expect(tool.tool.content).not.toContain('[~]')
        expect(tool.tool.content).not.toContain('[-] Ship')
      }
    }
  })

  it('drops never-started running tools when the run completed normally', () => {
    const events = [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' as const }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: {
          type: 'tool_call_delta' as const,
          runId: 'r1',
          toolCallId: 'orphan',
          name: 'edit',
          argumentsDelta: '{"path":"a.ts"}'
        }
      },
      {
        at: '2026-07-24T12:00:03.000Z',
        event: { type: 'status', runId: 'r1', status: 'done' as const }
      }
    ]
    const items = applyEventTimestamps(
      applyPersistedLiveTools(messagesToUiItems([{ role: 'user', content: 'go' }]), events),
      events
    )
    const finalized = finalizeHydratedTranscript(items, events)
    expect(finalized.some((item) => item.kind === 'tool')).toBe(false)
  })

  it('marks started-but-unsettled tools not completed when the run finished', () => {
    const events = [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' as const }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: { type: 'tool_start', runId: 'r1', toolCallId: 'c1', name: 'read' }
      },
      {
        at: '2026-07-24T12:00:03.000Z',
        event: { type: 'status', runId: 'r1', status: 'done' as const }
      }
    ]
    const items = applyEventTimestamps(
      messagesToUiItems([
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
        }
      ]),
      events
    )
    const finalized = finalizeHydratedTranscript(items, events)
    const tool = finalized.find((item) => item.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.status).toBe('fail')
      expect(tool.tool.content).toBe('Not completed')
    }
  })

  it('leaves running tools alone while the run is still active', () => {
    const events = [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' as const }
      }
    ]
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      }
    ])
    const finalized = finalizeHydratedTranscript(items, events)
    const tool = finalized.find((item) => item.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') expect(tool.tool.status).toBe('running')
  })

  it('treats stale running status as cancelled when idle hydrate asks', () => {
    const events = [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: { type: 'status', runId: 'r1', status: 'running' as const }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: { type: 'tool_start', runId: 'r1', toolCallId: 'c1', name: 'read' }
      }
    ]
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      }
    ])
    const finalized = finalizeHydratedTranscript(items, events, { treatRunningAs: 'cancelled' })
    const tool = finalized.find((item) => item.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.status).toBe('fail')
      expect(tool.tool.content).toBe('Cancelled')
    }
  })
})

describe('messagesToUiItems tool ok', () => {
  it('uses persisted ok flag instead of content heuristics', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        toolName: 'read',
        content: 'permission denied',
        ok: false
      }
    ])
    const tool = items.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') expect(tool.tool.status).toBe('fail')
  })

  it('keeps distinct rows when assistant/tool ids are empty (legacy DeepSeek)', () => {
    const items = messagesToUiItems([
      {
        role: 'assistant',
        content: 'go',
        toolCalls: [
          { id: '', name: 'web_fetch', arguments: '{"url":"https://a.example"}' },
          { id: '', name: 'terminal', arguments: '{"command":"ls"}' }
        ]
      },
      {
        role: 'tool',
        toolCallId: '',
        toolName: 'web_fetch',
        content: 'Tool call missing id',
        ok: false
      },
      {
        role: 'tool',
        toolCallId: '',
        toolName: 'terminal',
        content: 'Tool call missing id',
        ok: false
      }
    ])
    const tools = items.filter((i) => i.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(new Set(tools.map((t) => t.id)).size).toBe(2)
    if (tools[0]?.kind === 'tool' && tools[1]?.kind === 'tool') {
      expect(tools[0].tool.name).toBe('web_fetch')
      expect(tools[0].tool.status).toBe('fail')
      expect(tools[1].tool.name).toBe('terminal')
      expect(tools[1].tool.status).toBe('fail')
    }
  })
})

describe('applyCompactionItems', () => {
  it('weaves persisted summaries into the transcript by timestamp', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' }
    ])
    const stamped = items.map((item, index) => ({
      ...item,
      at: `2026-08-12T00:00:0${index}.000Z`
    }))
    const next = applyCompactionItems(stamped, [
      {
        at: '2026-08-12T00:00:01.500Z',
        event: {
          type: 'compaction',
          runId: 'r1',
          summary: 'First turn covered the setup.',
          kind: 'summary',
          verified: true,
          verifyCoverage: 1
        }
      }
    ])
    expect(next.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction',
      'message'
    ])
    const compact = next[2]
    expect(compact?.kind === 'compaction' ? compact.summary : null).toBe(
      'First turn covered the setup.'
    )
    expect(compact?.kind === 'compaction' ? compact.verifyStatus : null).toBe('verified')
  })

  it('weaves a failed verification card from compaction_verify_failed', () => {
    const items = messagesToUiItems([{ role: 'user', content: 'first' }]).map((item) => ({
      ...item,
      at: '2026-08-12T00:00:00.000Z'
    }))
    const next = applyCompactionItems(items, [
      {
        at: '2026-08-12T00:00:01.000Z',
        event: {
          type: 'compaction_verify_failed',
          runId: 'r1',
          summary: 'Bad fold',
          failures: ['Invented path: src/fake.ts']
        }
      }
    ])
    const compact = next.find((item) => item.kind === 'compaction')
    expect(compact?.kind === 'compaction' ? compact.verifyStatus : null).toBe('failed')
    expect(compact?.kind === 'compaction' ? compact.verifyFailures : null).toEqual([
      'Invented path: src/fake.ts'
    ])
  })

  it('inserts a live summary by timestamp without duplicating', () => {
    const items = messagesToUiItems([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' }
    ]).map((item, index) => ({
      ...item,
      at: `2026-08-12T00:00:0${index}.000Z`
    }))
    const extra = {
      kind: 'compaction' as const,
      id: 'compaction:live',
      summary: 'First turn covered the setup.',
      at: '2026-08-12T00:00:01.500Z'
    }
    const next = insertCompactionItem(items, extra)
    expect(next.map((item) => item.kind)).toEqual([
      'message',
      'message',
      'compaction',
      'message'
    ])
    expect(insertCompactionItem(next, extra).filter((item) => item.kind === 'compaction')).toHaveLength(
      1
    )
  })

  it('does not treat a failed compact card as the same as a later verified fold', () => {
    const failed = {
      kind: 'compaction' as const,
      id: 'compaction:0:Same text',
      summary: 'Same text',
      at: '2026-08-12T00:00:01.000Z',
      verifyStatus: 'failed' as const,
      verifyFailures: ['Missing decision: Use JWT']
    }
    const verified = {
      kind: 'compaction' as const,
      id: 'compaction:1:Same text',
      summary: 'Same text',
      at: '2026-08-12T00:00:01.000Z',
      verifyStatus: 'verified' as const
    }
    const next = insertCompactionItem([failed], verified)
    expect(next.filter((item) => item.kind === 'compaction')).toHaveLength(2)
  })
})


