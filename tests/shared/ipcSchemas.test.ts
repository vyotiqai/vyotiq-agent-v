import { describe, expect, it } from 'vitest'
import {
  ChatMessageSchema,
  ChatStartRequestSchema,
  ChatRewindAndStartRequestSchema,
  ChatStartResultSchema,
  ChatFollowUpRequestSchema,
  ChatFollowUpResultSchema,
  CancelRunRequestSchema,
  CompactRunRequestSchema,
  DeleteRunRequestSchema,
  RenameRunRequestSchema,
  LoadRunEventsRequestSchema,
  ExtractAttachmentRequestSchema,
  DictationTranscribeRequestSchema,
  MAX_ATTACHMENT_DATA_CHARS,
  SetSettingsRequestSchema,
  SetSecretRequestSchema,
  ListModelsRequestSchema,
  ModelInfoSchema,
  ProviderIdSchema,
  AgentEventSchema,
  AgentQuestionRequestSchema,
  AgentQuestionResponseSchema,
  WindowMaximizedChangedSchema,
  LoadRunRequestSchema,
  LoadRunResultSchema,
  LoadToolResultRequestSchema,
  SettingsSchema,
  DEFAULT_SETTINGS,
  DEFAULT_THINKING_EFFORT,
  DEFAULT_NOTIFICATION_SETTINGS,
  NotificationItemSchema,
  NotificationMutateRequestSchema,
  TelemetryStatusSchema,
  AppInfoSchema,
  SECRET_PROVIDERS,
  SecretProviderSchema,
  emptySecretStatus,
  emptySecretsStatus,
  secretStatusFromKeys,
  ok,
  fail,
  MAX_IMAGE_DATA_URL_CHARS,
  contentHasImage,
  contentToText,
  ToolApprovalRequestSchema,
  ToolApprovalResponseSchema,
  ActiveRunSchema,
  GitStatusResultSchema,
  GitStatusSchema,
  WorkspaceEditorRecoverySaveRequestSchema,
  WorkspaceEditorRecoverySnapshotSchema
} from '@shared/ipc'
import { IPC } from '@shared/channels'
import { PROVIDER_DEFAULTS, seedModelsFor } from '@shared/providers'
import type { VyotiqApi } from '@shared/vyotiqApi'

describe('ipc schemas', () => {

  it('requires a recovery session token and bounds aggregate recovery content', () => {
    const snapshot = {
      version: 1 as const,
      activeTabId: null,
      tabs: [],
      savedAt: new Date().toISOString()
    }
    const content = 'x'.repeat(12 * 1024 * 1024 + 1)
    expect(
      WorkspaceEditorRecoverySaveRequestSchema.safeParse({
        workspacePath: '/workspace',
        generation: 0,
        snapshot
      }).success
    ).toBe(false)
    expect(
      WorkspaceEditorRecoverySnapshotSchema.safeParse({
        ...snapshot,
        tabs: Array.from({ length: 4 }, (_, index) => ({
          id: `tab-${index}`,
          path: `tab-${index}.txt`,
          kind: 'text' as const,
          content,
          encoding: 'utf8' as const,
          eol: 'none' as const,
          bom: false,
          version: null,
          dirty: true,
          cursor: 0,
          selections: [],
          bookmarks: [],
          template: null
        }))
      }).success
    ).toBe(false)
  })

  it('parses chat start with tool messages', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool' as const, content: 'ok', toolCallId: '1', toolName: 'read' }
    ]
    const parsed = ChatStartRequestSchema.parse({ messages, workspacePath: '/ws' })
    expect(parsed.messages).toHaveLength(3)
    expect(ChatMessageSchema.parse(messages[2]).toolCallId).toBe('1')
  })

  it('keeps optional user send timestamps on chat messages', () => {
    const parsed = ChatMessageSchema.parse({
      role: 'user',
      content: 'hi',
      at: '2026-07-24T12:00:00.000Z'
    })
    expect(parsed.at).toBe('2026-07-24T12:00:00.000Z')
    expect(ChatMessageSchema.parse({ role: 'user', content: 'hi' }).at).toBeUndefined()
    expect(
      ChatMessageSchema.safeParse({ role: 'user', content: 'hi', at: 'not-a-datetime' }).success
    ).toBe(false)
  })

  it('rejects full messages on chatStart resume unless incremental', () => {
    const user = { role: 'user' as const, content: 'hi' }
    expect(
      ChatStartRequestSchema.safeParse({
        messages: [user],
        workspacePath: '/ws',
        runId: 'run-1'
      }).success
    ).toBe(false)
    expect(
      ChatStartRequestSchema.safeParse({
        incremental: true,
        newMessages: [user],
        workspacePath: '/ws',
        runId: 'run-1'
      }).success
    ).toBe(true)
    expect(
      ChatStartRequestSchema.safeParse({ messages: [user], workspacePath: '/ws' }).success
    ).toBe(true)
    expect(
      ChatStartRequestSchema.safeParse({
        workspacePath: '/ws',
        runId: 'run-1',
        messages: []
      }).success
    ).toBe(true)
    expect(
      ChatStartRequestSchema.safeParse({
        workspacePath: '/ws',
        runId: 'run-1'
      }).success
    ).toBe(true)
  })

  it('accepts session-pinned provider/model on chatStart and rewind requests', () => {
    const user = { role: 'user' as const, content: 'hi' }
    expect(
      ChatStartRequestSchema.safeParse({
        messages: [user],
        workspacePath: '/ws',
        provider: 'openai',
        model: 'gpt-session'
      }).success
    ).toBe(true)
    expect(
      ChatStartRequestSchema.safeParse({
        messages: [user],
        workspacePath: '/ws',
        provider: 'not-a-provider',
        model: 'gpt-session'
      }).success
    ).toBe(false)
    expect(
      ChatStartRequestSchema.safeParse({
        messages: [user],
        workspacePath: '/ws',
        model: ''
      }).success
    ).toBe(false)
    expect(
      ChatRewindAndStartRequestSchema.safeParse({
        workspacePath: '/ws',
        runId: 'run-1',
        editMessageIndex: 0,
        editedUserMessage: user,
        provider: 'anthropic',
        model: 'claude-session'
      }).success
    ).toBe(true)
  })

  it('rejects empty model in settings patch', () => {
    expect(() => SetSettingsRequestSchema.parse({ model: '' })).toThrow()
  })

  it('rejects whitespace-only API keys', () => {
    expect(() =>
      SetSecretRequestSchema.parse({ provider: 'openai', key: '   ' })
    ).toThrow()
  })

  it('parses multimodal user content parts', () => {
    const msg = ChatMessageSchema.parse({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', url: 'data:image/png;base64,aaa' }
      ]
    })
    expect(contentHasImage(msg.content)).toBe(true)
    expect(contentToText(msg.content)).toContain('look')
  })

  it('accepts all eleven providers', () => {
    for (const id of [
      'openai',
      'anthropic',
      'gemini',
      'ollama',
      'deepseek',
      'groq',
      'openrouter',
      'xai',
      'mistral',
      'custom'
    ]) {
      expect(ProviderIdSchema.parse(id)).toBe(id)
    }
    expect(PROVIDER_DEFAULTS).toHaveLength(11)
    expect(ListModelsRequestSchema.parse({ provider: 'groq' }).provider).toBe('groq')
    expect(ListModelsRequestSchema.parse({ provider: 'ollama', model: 'glm-5.2' }).model).toBe(
      'glm-5.2'
    )
    expect(IPC.listModels).toBe('models:list')
  })

  it('lists eleven secret providers including ollama and custom', () => {
    expect(SECRET_PROVIDERS).toHaveLength(11)
    expect(SECRET_PROVIDERS).toContain('ollama')
    expect(SECRET_PROVIDERS).toContain('custom')
    expect(SecretProviderSchema.safeParse('ollama').success).toBe(true)
    expect(emptySecretStatus().openai).toBe(false)
    expect(emptySecretStatus().ollama).toBe(false)
  })

  it('keeps SecretsStatus shape (encryptionAvailable + keys)', () => {
    const unavailable = emptySecretsStatus(false)
    expect(unavailable.encryptionAvailable).toBe(false)
    expect(unavailable.keys.openai).toBe(false)
    expect(Object.keys(unavailable.keys)).toHaveLength(SECRET_PROVIDERS.length)
  })

  it('rejects oversized image_url data URLs', () => {
    const huge = 'data:image/png;base64,' + 'a'.repeat(MAX_IMAGE_DATA_URL_CHARS)
    expect(() =>
      ChatMessageSchema.parse({
        role: 'user',
        content: [{ type: 'image_url', url: huge }]
      })
    ).toThrow()
    expect(
      ChatMessageSchema.parse({
        role: 'user',
        content: [{ type: 'image_url', url: 'data:image/png;base64,aa' }]
      }).content
    ).toEqual([{ type: 'image_url', url: 'data:image/png;base64,aa' }])
  })

  it('parses cancel and agent events', () => {
    expect(CancelRunRequestSchema.parse({ runId: 'abc' })).toEqual({ runId: 'abc' })
    expect(
      ChatFollowUpRequestSchema.parse({
        runId: 'abc',
        message: { role: 'user', content: 'steer' }
      })
    ).toEqual({
      runId: 'abc',
      message: { role: 'user', content: 'steer' }
    })
    expect(ChatFollowUpResultSchema.parse({ id: 'fu-1', position: 1, queueLength: 1 })).toEqual({
      id: 'fu-1',
      position: 1,
      queueLength: 1
    })
    expect(() =>
      ChatFollowUpRequestSchema.parse({
        runId: 'abc',
        message: { role: 'assistant', content: 'nope' }
      })
    ).toThrow()
    expect(
      AgentEventSchema.parse({
        type: 'tool_result',
        runId: 'r1',
        toolCallId: 't1',
        name: 'read',
        summary: 'a.ts',
        ok: true,
        content: 'file'
      }).type
    ).toBe('tool_result')
    expect(
      AgentEventSchema.parse({
        type: 'tool_result',
        runId: 'r1',
        toolCallId: 't1',
        name: 'read',
        summary: 'big.ts',
        ok: true,
        content: 'preview',
        contentTruncated: true
      }).contentTruncated
    ).toBe(true)
    expect(
      AgentEventSchema.parse({
        type: 'tool_call_delta',
        runId: 'r1',
        toolCallId: 't1',
        argumentsDelta: '{"path":'
      }).type
    ).toBe('tool_call_delta')
    expect(
      AgentEventSchema.parse({
        type: 'assistant_message',
        runId: 'r1',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      }).toolCalls
    ).toHaveLength(1)
    expect(
      AgentEventSchema.parse({
        type: 'text_delta',
        runId: 'r1',
        text: 'hi'
      }).text
    ).toBe('hi')
    expect(
      AgentEventSchema.parse({
        type: 'thinking_delta',
        runId: 'r1',
        text: 'reason',
        step: 1
      }).type
    ).toBe('thinking_delta')
    expect(
      AgentEventSchema.parse({
        type: 'thinking_done',
        runId: 'r1',
        text: 'done reasoning',
        step: 1
      }).text
    ).toBe('done reasoning')
    expect(
      AgentEventSchema.parse({
        type: 'error',
        runId: 'r1',
        message: 'boom',
        code: 'AGENT_LOOP'
      })
    ).toEqual({
      type: 'error',
      runId: 'r1',
      message: 'boom',
      code: 'AGENT_LOOP'
    })
    expect(
      AgentEventSchema.parse({
        type: 'step_usage',
        runId: 'r1',
        step: 2,
        inputTokens: 1000,
        outputTokens: 50,
        cachedInputTokens: 800
      }).cachedInputTokens
    ).toBe(800)
    expect(
      AgentEventSchema.parse({
        type: 'step_usage',
        runId: 'r1',
        step: 3,
        inputTokens: 1000,
        outputTokens: 50,
        cacheCreationInputTokens: 400
      }).cacheCreationInputTokens
    ).toBe(400)
    expect(
      AgentEventSchema.parse({
        type: 'step_usage',
        runId: 'r1',
        step: 4,
        inputTokens: 10,
        outputTokens: 2,
        billedCost: 0.0123,
        billedCostSaved: -0.001
      }).billedCost
    ).toBe(0.0123)
    expect(
      AgentEventSchema.parse({
        type: 'step_usage',
        runId: 'r1',
        step: 5,
        inputTokens: 10,
        outputTokens: 40,
        generationMs: 2500
      }).generationMs
    ).toBe(2500)
    expect(
      AgentEventSchema.parse({
        type: 'context_usage',
        runId: 'r1',
        step: 1,
        estimatedTokens: 1200,
        inputTokens: 1100,
        contextWindow: 128000,
        compactionTrigger: 70000,
        source: 'provider',
        layers: { system: 100, history: 900, tools: 200, buffer: 0 }
      }).source
    ).toBe('provider')
    expect(
      AgentEventSchema.parse({
        type: 'error',
        runId: 'r1',
        message: 'boom'
      }).code
    ).toBeUndefined()
    expect(
      AgentEventSchema.parse({
        type: 'stream_reset',
        runId: 'r1',
        step: 2
      }).type
    ).toBe('stream_reset')
    expect(
      AgentEventSchema.parse({
        type: 'token_cost_hint',
        runId: 'r1',
        kind: 'high_thinking_on_long_run',
        message: 'Lower effort or /clear between tasks.'
      }).kind
    ).toBe('high_thinking_on_long_run')
    expect(
      AgentEventSchema.parse({
        type: 'token_cost_hint',
        runId: 'r1',
        kind: 'long_run_task_boundary',
        message: 'Use /clear when starting an unrelated task.'
      }).kind
    ).toBe('long_run_task_boundary')
    expect(
      AgentEventSchema.parse({
        type: 'compaction_started',
        runId: 'r1',
        mode: 'auto'
      })
    ).toEqual({
      type: 'compaction_started',
      runId: 'r1',
      mode: 'auto'
    })
    expect(
      AgentEventSchema.parse({
        type: 'compaction_verifying',
        runId: 'r1',
        summary: 'draft'
      }).type
    ).toBe('compaction_verifying')
    expect(
      AgentEventSchema.parse({
        type: 'compaction_verify_retry',
        runId: 'r1',
        failures: ['Invented path: src/fake.ts']
      }).failures
    ).toEqual(['Invented path: src/fake.ts'])
    expect(
      AgentEventSchema.parse({
        type: 'compaction_verify_failed',
        runId: 'r1',
        summary: 'bad fold',
        failures: ['Missing decision: Use JWT']
      }).type
    ).toBe('compaction_verify_failed')
    expect(
      AgentEventSchema.safeParse({
        type: 'compaction_verify_failed',
        runId: 'r1',
        failures: Array.from({ length: 17 }, (_, i) => `Invented path: src/f${i}.ts`)
      }).success
    ).toBe(false)
    expect(
      AgentEventSchema.safeParse({
        type: 'compaction_verify_failed',
        runId: 'r1',
        failures: Array.from({ length: 16 }, (_, i) => `Invented path: src/f${i}.ts`)
      }).success
    ).toBe(true)
    expect(
      AgentEventSchema.parse({
        type: 'compaction',
        runId: 'r1',
        summary: 'folded',
        kind: 'summary',
        verified: true,
        verifyCoverage: 1
      }).verified
    ).toBe(true)
    expect(
      AgentEventSchema.parse({
        type: 'mode_changed',
        runId: 'r1',
        mode: 'plan'
      }).mode
    ).toBe('plan')
    expect(
      AgentEventSchema.parse({
        type: 'goal_update',
        runId: 'r1',
        goal: {
          objective: 'Ship',
          status: 'active',
          createdAt: 't',
          updatedAt: 't'
        },
        notice: 'Resuming goal: Ship'
      }).notice
    ).toBe('Resuming goal: Ship')
    expect(
      AgentEventSchema.parse({
        type: 'loop_update',
        runId: 'r1',
        loop: {
          prompt: 'check CI',
          intervalMs: 30_000,
          status: 'armed',
          nextAt: 't'
        }
      }).loop?.status
    ).toBe('armed')
    expect(
      AgentQuestionRequestSchema.parse({
        requestId: 'q1',
        runId: 'r1',
        toolCallId: 't1',
        questions: [
          { id: 'q1', prompt: 'Ready?', type: 'single', options: ['yes', 'no'] }
        ]
      }).questions[0]!.prompt
    ).toBe('Ready?')
    expect(
      AgentQuestionResponseSchema.parse({
        requestId: 'q1',
        runId: 'r1',
        answers: [{ questionId: 'q1', values: ['yes'] }]
      }).answers
    ).toEqual([{ questionId: 'q1', values: ['yes'] }])
    expect(
      AgentEventSchema.parse({
        type: 'incomplete',
        runId: 'r1',
        reason: 'empty_response',
        step: 1,
        message: 'The model returned an empty response.'
      }).reason
    ).toBe('empty_response')
    expect(
      AgentEventSchema.parse({
        type: 'tool_progress',
        runId: 'r1',
        parentToolCallId: 'c1',
        kind: 'tool',
        text: 'read a.ts'
      }).parentToolCallId
    ).toBe('c1')
    expect(
      AgentEventSchema.parse({
        type: 'subagent_update',
        runId: 'r1',
        parentToolCallId: 'legacy-1',
        kind: 'text',
        text: 'old progress'
      })
    ).toEqual({
      type: 'tool_progress',
      runId: 'r1',
      parentToolCallId: 'legacy-1',
      kind: 'text',
      text: 'old progress'
    })
    expect(
      AgentEventSchema.parse({
        type: 'terminal_output_delta',
        runId: 'r1',
        toolCallId: 't1',
        text: 'hello\n',
        stream: 'stdout'
      })
    ).toEqual({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 't1',
      text: 'hello\n',
      stream: 'stdout'
    })
    expect(
      AgentEventSchema.parse({
        type: 'terminal_output_delta',
        runId: 'r1',
        toolCallId: 't1',
        text: 'err\n'
      }).stream
    ).toBeUndefined()
    expect(
      AgentEventSchema.parse({
        type: 'tool_progress',
        runId: 'r1',
        parentToolCallId: 'c1',
        kind: 'text',
        text: 'Resolving…'
      }).kind
    ).toBe('text')
    expect(
      AgentEventSchema.parse({
        type: 'follow_up_queued',
        runId: 'r1',
        id: 'fu-1',
        position: 1,
        queueLength: 1,
        preview: 'please also fix tests'
      }).preview
    ).toBe('please also fix tests')
    expect(
      AgentEventSchema.parse({
        type: 'follow_up_queued',
        runId: 'r1',
        id: 'fu-1',
        position: 1,
        queueLength: 1
      }).id
    ).toBe('fu-1')
    expect(
      AgentEventSchema.parse({
        type: 'follow_up_applied',
        runId: 'r1',
        ids: ['fu-1'],
        messages: [{ role: 'user', content: 'steer' }]
      }).ids
    ).toEqual(['fu-1'])
    expect(
      AgentEventSchema.parse({
        type: 'follow_up_dropped',
        runId: 'r1',
        ids: ['fu-1'],
        reason: 'identical_step_streak'
      }).reason
    ).toBe('identical_step_streak')
    expect(WindowMaximizedChangedSchema.parse(true)).toBe(true)
    expect(LoadRunRequestSchema.parse({ workspacePath: '/ws', runId: 'r1' })).toEqual({
      workspacePath: '/ws',
      runId: 'r1'
    })
    expect(
      LoadRunResultSchema.parse({
        runId: 'r1',
        messages: [{ role: 'user', content: 'hi' }],
        pendingFollowUps: [{ id: 'fu-1', preview: 'hi', ready: true }],
        status: 'cancelled',
        resumable: true,
        error: 'Interrupted'
      })
    ).toMatchObject({
      runId: 'r1',
      status: 'cancelled',
      resumable: true
    })
    expect(
      LoadToolResultRequestSchema.parse({
        workspacePath: '/ws',
        runId: 'r1',
        toolCallId: 'call-1'
      })
    ).toEqual({
      workspacePath: '/ws',
      runId: 'r1',
      toolCallId: 'call-1'
    })
  })

  it('rejects run ids that can escape the sessions directory', () => {
    const traversals = ['..', '../../..', '../sibling', '..\\..\\secrets', '/etc/passwd', 'C:\\Windows', 'a/b', '']
    const runScoped = [
      { schema: LoadRunRequestSchema, base: { workspacePath: '/ws' } },
      { schema: LoadRunEventsRequestSchema, base: { workspacePath: '/ws' } },
      { schema: LoadToolResultRequestSchema, base: { workspacePath: '/ws', toolCallId: 'c1' } },
      { schema: DeleteRunRequestSchema, base: { workspacePath: '/ws' } },
      { schema: RenameRunRequestSchema, base: { workspacePath: '/ws', goal: 'g' } },
      { schema: CompactRunRequestSchema, base: { workspacePath: '/ws' } },
      { schema: CancelRunRequestSchema, base: {} }
    ]
    for (const { schema, base } of runScoped) {
      for (const runId of traversals) {
        expect(schema.safeParse({ ...base, runId }).success).toBe(false)
      }
      expect(schema.safeParse({ ...base, runId: '3f2a8c1e-0b7d-4a11-9d0e-2c1f5b6a7c88' }).success).toBe(
        true
      )
    }
    expect(
      ChatStartRequestSchema.safeParse({
        messages: [{ role: 'user', content: 'hi' }],
        workspacePath: '/ws',
        runId: '../../..'
      }).success
    ).toBe(false)
  })

  it('caps attachment payload size before main decodes it', () => {
    const oversized = 'a'.repeat(MAX_ATTACHMENT_DATA_CHARS + 1)
    expect(
      ExtractAttachmentRequestSchema.safeParse({ name: 'big.txt', mime: 'text/plain', data: oversized })
        .success
    ).toBe(false)
    expect(
      ExtractAttachmentRequestSchema.parse({ name: 'a.txt', mime: 'text/plain', data: 'aGk=' }).data
    ).toBe('aGk=')
  })

  it('allows cloud dictation without pcm16k and accepts optional pcm16k', () => {
    const cloud = DictationTranscribeRequestSchema.parse({
      mime: 'audio/webm',
      data: 'aGk='
    })
    expect(cloud.pcm16k).toBeUndefined()
    const local = DictationTranscribeRequestSchema.parse({
      mime: 'audio/webm',
      data: 'aGk=',
      pcm16k: 'AAABAA=='
    })
    expect(local.pcm16k).toBe('AAABAA==')
  })

  it('maps secret key names to provider booleans', () => {
    const status = secretStatusFromKeys(['openai', 'groq', 'not-a-provider'])
    expect(status.openai).toBe(true)
    expect(status.groq).toBe(true)
    expect(status.anthropic).toBe(false)
    expect(Object.keys(status)).toHaveLength(SECRET_PROVIDERS.length)
  })

  it('wraps ipc ok/fail helpers', () => {
    expect(ok({ runId: 'x' })).toEqual({ ok: true, data: { runId: 'x' } })
    expect(fail('nope')).toEqual({ ok: false, error: 'nope' })
    expect(fail('nope', 'IPC_HANDLER')).toEqual({
      ok: false,
      error: 'nope',
      code: 'IPC_HANDLER'
    })
  })

  it('seeds deepseek without legacy chat ids', () => {
    const seeds = seedModelsFor('deepseek')
    expect(seeds.every((m) => !m.id.includes('deepseek-chat'))).toBe(true)
    expect(seeds.every((m) => !m.id.includes('deepseek-reasoner'))).toBe(true)
    expect(ModelInfoSchema.parse(seeds[0]).supportsTools).toBe(true)
  })

  it('seeds mid-2026 defaults for major providers', () => {
    expect(seedModelsFor('openai').map((m) => m.id)).toEqual([
      'gpt-5.6',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ])
    expect(seedModelsFor('anthropic')[0]?.id).toBe('claude-opus-5')
    expect(seedModelsFor('gemini')[0]?.id).toBe('gemini-3.6-flash')
    expect(seedModelsFor('xai')[0]?.id).toBe('grok-4-latest')
    expect(seedModelsFor('openai')[0]?.supportsThinking).toBe(true)
    expect(seedModelsFor('openai')[0]?.contextWindow).toBe(1_048_576)
  })

  it('keeps DEFAULT_SETTINGS aligned with SettingsSchema (incl. telemetry)', () => {
    const parsed = SettingsSchema.parse(DEFAULT_SETTINGS)
    expect(parsed).toEqual(DEFAULT_SETTINGS)
    expect(parsed.fontScale).toBe('default')
    expect(parsed.uiDensity).toBe('default')
    expect(parsed.accentPreset).toBe('blue')
    expect(parsed.telemetryEnabled).toBe(false)
    expect(parsed.autoCompactThresholdRatio).toBe(0.55)
    expect(parsed.settingsVersion).toBe(2)
    expect(parsed.thinkingEffort).toBe(DEFAULT_THINKING_EFFORT)
    expect(parsed.thinkingEffort).toBe('low')
    expect(parsed.autoModeSwitch).toBe(false)
    expect(parsed.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    // Legacy settings files omit telemetryEnabled — default fills it
    const legacy = SettingsSchema.parse({
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      theme: 'system'
    })
    expect(legacy.telemetryEnabled).toBe(false)
    expect(legacy.autoCompactThresholdRatio).toBe(0.55)
    expect(legacy.settingsVersion).toBe(2)
    expect(legacy.thinkingEffort).toBe('low')
    expect(legacy.autoModeSwitch).toBe(false)
    expect(legacy.offlineWaitMode).toBe('default')
    expect(legacy.fontScale).toBe('default')
    expect(legacy.uiDensity).toBe('default')
    expect(legacy.accentPreset).toBe('blue')
    expect(parsed.dictation.engine).toBe('openai')
    expect(legacy.dictation.engine).toBe('openai')
    expect(legacy.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS)
    expect(parsed.tabAutocomplete).toBe(true)
    expect(legacy.tabAutocomplete).toBe(true)
    expect(parsed.toolApproval.mcpProtection).toBe(true)
    expect(legacy.toolApproval.mcpProtection).toBe(true)
    expect(SetSettingsRequestSchema.parse({ telemetryEnabled: true })).toEqual({
      telemetryEnabled: true
    })
  })

  it('rejects notification items with an empty title', () => {
    expect(() =>
      NotificationItemSchema.parse({
        id: 'n1',
        createdAt: '2026-08-16T00:00:00.000Z',
        read: false,
        source: 'agent',
        kind: 'run_done',
        title: '',
        body: 'done',
        dedupeKey: 'run:r1:done'
      })
    ).toThrow()
    expect(NotificationMutateRequestSchema.parse({ id: 'n1' })).toEqual({ id: 'n1' })
    expect(NotificationMutateRequestSchema.parse({ all: true })).toEqual({ all: true })
  })

  it('parses model picker preference fields on settings', () => {
    const parsed = SettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      favoriteModels: ['openai:gpt-4o'],
      recentModels: ['anthropic:claude-sonnet-4', 'openai:gpt-4o'],
      thinkingPrefsByProvider: {
        openai: { thinkingEnabled: true, thinkingEffort: 'high' }
      },
      serviceTierByModel: { 'openai:gpt-4o': 'priority' },
      serviceTier: 'flex'
    })
    expect(parsed.favoriteModels).toEqual(['openai:gpt-4o'])
    expect(parsed.recentModels).toHaveLength(2)
    expect(parsed.thinkingPrefsByProvider.openai?.thinkingEffort).toBe('high')
    expect(parsed.serviceTierByModel['openai:gpt-4o']).toBe('priority')
    expect(parsed.serviceTier).toBe('flex')
    expect(() =>
      SettingsSchema.parse({ ...DEFAULT_SETTINGS, recentModels: Array(6).fill('openai:a') })
    ).toThrow()
  })

  it('parses telemetry status payload', () => {
    expect(
      TelemetryStatusSchema.parse({ dsnConfigured: true, telemetryEnabled: false })
    ).toEqual({ dsnConfigured: true, telemetryEnabled: false })
    expect(() => TelemetryStatusSchema.parse({ dsnConfigured: true })).toThrow()
  })

  it('parses app info payload', () => {
    const info = {
      name: 'Vyotiq',
      version: '1.0.0',
      homepage: 'https://vyotiq.com',
      electron: '43.2.0',
      chrome: '132.0.6834.196',
      node: '22.17.0',
      platform: 'win32',
      arch: 'x64',
      osVersion: '10.0.26200'
    }
    expect(AppInfoSchema.parse(info)).toEqual(info)
    expect(() => AppInfoSchema.parse({ name: 'Vyotiq', version: '1.0.0' })).toThrow()
    expect(() =>
      AppInfoSchema.parse({ ...info, homepage: 'http://vyotiq.com' })
    ).toThrow()
    expect(() => AppInfoSchema.parse({ ...info, homepage: 'not-a-url' })).toThrow()
  })

  it('exposes logging IPC channels used by VyotiqApi', () => {
    expect(IPC.logsOpenDir).toBe('logs:open-dir')
    expect(IPC.logsGetPath).toBe('logs:get-path')
    expect(IPC.telemetryStatus).toBe('telemetry:status')
    // Compile-time surface check — method names must exist on VyotiqApi
    const apiKeys: (keyof VyotiqApi)[] = [
      'openLogsDir',
      'getLogsPath',
      'telemetryStatus'
    ]
    expect(apiKeys).toHaveLength(3)
  })

  it('requires invokeId on chat start results and active runs', () => {
    expect(ChatStartResultSchema.parse({ runId: 'r1', invokeId: 1 })).toEqual({
      runId: 'r1',
      invokeId: 1
    })
    expect(() => ChatStartResultSchema.parse({ runId: 'r1' })).toThrow()
    expect(
      ActiveRunSchema.parse({ runId: 'r1', workspacePath: '/ws', invokeId: 2 })
    ).toEqual({ runId: 'r1', workspacePath: '/ws', invokeId: 2, pendingFollowUps: [] })
    expect(() => ActiveRunSchema.parse({ runId: 'r1', workspacePath: '/ws' })).toThrow()
  })

  it('parses tool approval request/response and git status shapes', () => {
    expect(
      ToolApprovalRequestSchema.parse({
        requestId: 'req-1',
        runId: 'r1',
        toolCallId: 'c1',
        name: 'edit',
        summary: 'a.ts',
        argsPreview: '{}',
        mutating: true
      }).name
    ).toBe('edit')
    expect(
      ToolApprovalResponseSchema.parse({
        requestId: 'req-1',
        runId: 'r1',
        decision: 'once'
      })
    ).toEqual({ requestId: 'req-1', runId: 'r1', decision: 'once' })
    expect(
      GitStatusSchema.parse({
        branch: 'main',
        fileCount: 1,
        added: 2,
        removed: 0,
        truncated: false,
        hasRemote: true,
        hasCommits: true,
        files: [
          {
            path: 'a.ts',
            status: 'modified',
            added: 2,
            removed: 0,
            addedStaged: 0,
            removedStaged: 0,
            addedUnstaged: 2,
            removedUnstaged: 0,
            binary: false,
            staged: false,
            unstaged: true
          }
        ]
      }).branch
    ).toBe('main')
    expect(GitStatusResultSchema.parse({ kind: 'not_repo' })).toEqual({ kind: 'not_repo' })
    expect(
      GitStatusResultSchema.parse({
        kind: 'unavailable',
        detail: 'Git is not installed or not on PATH'
      }).kind
    ).toBe('unavailable')
  })

  it('parses stage/unstage path and github auth schemas', async () => {
    const {
      GitStagePathsRequestSchema,
      GitUnstagePathsRequestSchema,
      GitBranchesResultSchema,
      GithubAuthStatusSchema,
      GithubCliInstallResultSchema,
      ShellOpenExternalRequestSchema,
      SettingsSchema,
      DEFAULT_SETTINGS
    } = await import('@shared/ipc')
    expect(
      GitStagePathsRequestSchema.parse({ workspacePath: '/ws', paths: ['a.ts'] }).paths
    ).toEqual(['a.ts'])
    expect(
      GitUnstagePathsRequestSchema.parse({ workspacePath: '/ws', paths: ['a.ts'] }).paths[0]
    ).toBe('a.ts')
    expect(GitBranchesResultSchema.parse([{ name: 'main', current: true }])).toHaveLength(1)
    expect(
      GithubAuthStatusSchema.parse({
        ghAvailable: true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: null
      }).pending
    ).toBe(false)
    expect(
      GithubCliInstallResultSchema.parse({
        installed: true,
        detail: 'GitHub CLI installed with winget.',
        ghAvailable: true
      }).ghAvailable
    ).toBe(true)
    expect(ShellOpenExternalRequestSchema.parse({ url: 'https://github.com' }).url).toContain(
      'github'
    )
    expect(SettingsSchema.parse(DEFAULT_SETTINGS).googleMcpClientId).toBe('')
  })

  it('parses pty list/create request schemas', async () => {
    const { PtyCreateRequestSchema, PtyListRequestSchema, PtyResizeRequestSchema } =
      await import('@shared/ipc')
    expect(PtyListRequestSchema.parse({})).toEqual({})
    expect(PtyListRequestSchema.parse({ workspacePath: '/ws' })).toEqual({
      workspacePath: '/ws'
    })
    expect(
      PtyCreateRequestSchema.parse({ workspacePath: '/ws', cols: 80, rows: 24 }).workspacePath
    ).toBe('/ws')
    expect(PtyResizeRequestSchema.safeParse({ id: 'x', cols: 0, rows: 24 }).success).toBe(false)
  })

  it('parses browser navigate/screenshot request schemas', async () => {
    const { BrowserNavigateRequestSchema, BrowserTakeScreenshotRequestSchema } =
      await import('@shared/ipc')
    expect(BrowserNavigateRequestSchema.parse('https://example.com')).toEqual({
      url: 'https://example.com'
    })
    expect(BrowserNavigateRequestSchema.parse({ url: 'https://example.com/x' })).toEqual({
      url: 'https://example.com/x'
    })
    expect(
      BrowserNavigateRequestSchema.parse({
        url: 'https://example.com/x',
        workspacePath: '/ws'
      })
    ).toEqual({
      url: 'https://example.com/x',
      workspacePath: '/ws'
    })
    expect(BrowserNavigateRequestSchema.safeParse('').success).toBe(false)
    expect(BrowserNavigateRequestSchema.safeParse({}).success).toBe(false)
    expect(
      BrowserTakeScreenshotRequestSchema.parse({
        workspacePath: '/ws',
        runId: 'run-1',
        tabId: 'tab-a'
      })
    ).toEqual({ workspacePath: '/ws', runId: 'run-1', tabId: 'tab-a' })
    expect(
      BrowserTakeScreenshotRequestSchema.parse({ workspacePath: '/ws' })
    ).toEqual({ workspacePath: '/ws' })
  })

  it('parses browser select/close request schemas with optional workspacePath', async () => {
    const { BrowserSelectTabRequestSchema, BrowserCloseTabRequestSchema } =
      await import('@shared/ipc')
    expect(BrowserSelectTabRequestSchema.parse({ tabId: 't1' })).toEqual({ tabId: 't1' })
    expect(
      BrowserSelectTabRequestSchema.parse({ tabId: 't1', workspacePath: '/ws' })
    ).toEqual({ tabId: 't1', workspacePath: '/ws' })
    expect(BrowserSelectTabRequestSchema.safeParse({}).success).toBe(false)
    expect(BrowserCloseTabRequestSchema.parse({})).toEqual({})
    expect(
      BrowserCloseTabRequestSchema.parse({ tabId: 't1', workspacePath: '/ws' })
    ).toEqual({ tabId: 't1', workspacePath: '/ws' })
  })
})
