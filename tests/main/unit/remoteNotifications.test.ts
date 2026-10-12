import { describe, expect, it, vi } from 'vitest'
import {
  buildRemoteRequest,
  remoteUrlProblem,
  sendRemoteNotification
} from '../../../src/main/notifications/remote'

const message = { kind: 'needs_you' as const, title: 'Fix the parser needs you', body: 'Approve: npm test — résumé ✓' }

describe('phone notifications', () => {
  it('posts ntfy JSON at the server root with the topic inside', () => {
    const req = buildRemoteRequest('ntfy', 'https://ntfy.sh/agent-v-7f3k', message)
    expect(req.url).toBe('https://ntfy.sh/')
    const body = JSON.parse(String(req.init.body))
    expect(body).toMatchObject({ topic: 'agent-v-7f3k', title: message.title, message: message.body, priority: 4 })
    expect(body.tags).toEqual(['raising_hand'])
  })

  it('keeps a self-hosted ntfy path prefix', () => {
    expect(buildRemoteRequest('ntfy', 'https://push.example.com/ntfy/team/', message).url).toBe(
      'https://push.example.com/ntfy/'
    )
  })

  it('sends one webhook body Slack, Discord and a script can all read', () => {
    const req = buildRemoteRequest('webhook', 'https://hooks.slack.com/services/T/B/x', message)
    expect(req.url).toBe('https://hooks.slack.com/services/T/B/x')
    const body = JSON.parse(String(req.init.body))
    expect(body.text).toBe(`${message.title}\n${message.body}`)
    expect(body.content).toBe(body.text)
    expect(body).toMatchObject({ app: 'Agent V', kind: 'needs_you', title: message.title })
  })

  it('says what is wrong with an address', () => {
    expect(remoteUrlProblem('ntfy', 'ntfy.sh/topic')).toMatch(/not a URL/)
    expect(remoteUrlProblem('ntfy', 'https://ntfy.sh/')).toMatch(/Add the topic/)
    expect(remoteUrlProblem('webhook', 'ftp://x.example/hook')).toMatch(/https/)
    expect(remoteUrlProblem('webhook', 'https://user:pw@x.example/hook')).toMatch(/user name/)
    expect(remoteUrlProblem('webhook', 'https://x.example/hook')).toBeNull()
  })

  it('reports the server’s refusal', async () => {
    const fetchImpl = vi.fn(async () => new Response('topic is reserved', { status: 403 }))
    await expect(sendRemoteNotification('ntfy', 'https://ntfy.sh/t', message, fetchImpl as typeof fetch)).rejects.toThrow(
      'The server answered 403: topic is reserved'
    )
    const ok = vi.fn(async () => new Response('{}', { status: 200 }))
    await expect(sendRemoteNotification('webhook', 'https://x.example/h', message, ok as typeof fetch)).resolves.toBeUndefined()
    expect(ok).toHaveBeenCalledWith('https://x.example/h', expect.objectContaining({ method: 'POST' }))
  })
})
