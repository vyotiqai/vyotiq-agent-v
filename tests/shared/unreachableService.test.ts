import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import {
  mockServiceInstruction,
  unreachableServiceInText,
  unreachableServiceInTurn
} from '@shared/utils/unreachableService'

describe('unreachableServiceInText', () => {
  it.each([
    ['Error: connect ECONNREFUSED 127.0.0.1:6379', 'Redis'],
    ['Error: connect ECONNREFUSED ::1:6379', 'Redis'],
    ['connect ECONNREFUSED [::1]:5432', 'Postgres'],
    ["ERROR 2003 (HY000): Can't connect to MySQL server on 'localhost:3306' (111)", 'MySQL'],
    ['MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017', 'MongoDB'],
    ['ConnectionError: connect ECONNREFUSED 127.0.0.1:9200', 'Elasticsearch'],
    ['Error: connect ECONNREFUSED 127.0.0.1:5672', 'RabbitMQ'],
    ['Error: connect ECONNREFUSED 127.0.0.1:11211', 'Memcached'],
    ['Error: connect ECONNREFUSED 127.0.0.1:2181', 'ZooKeeper'],
    ['KafkaJSConnectionError: Connection error: connect ECONNREFUSED 127.0.0.1:9092', 'Kafka'],
    ['redis.exceptions.ConnectionError: Error 111 connecting to localhost:6379. Connection refused.', 'Redis'],
    ['Error: Redis connection to db.internal:6380 failed - connect ECONNREFUSED 10.0.0.5:6380', 'Redis'],
    ['Error: connect ETIMEDOUT 10.1.2.3:5432', 'Postgres'],
    ['Error: connect ECONNREFUSED redis://cache:6379', 'Redis'],
    ['Could not connect to Redis at 127.0.0.1:6380: Connection refused', 'Redis'],
    ['getaddrinfo ENOTFOUND redis', 'Redis']
  ])('names %j as %s', (text, name) => {
    expect(unreachableServiceInText(text)).toBe(name)
  })

  it('reads a port libpq gives on a later line', () => {
    const text = [
      'psycopg2.OperationalError: could not connect to server: Connection refused',
      '\tIs the server running on host "localhost" (127.0.0.1) and accepting',
      '\tTCP/IP connections on port 5432?'
    ].join('\n')
    expect(unreachableServiceInText(text)).toBe('Postgres')
  })

  it('names the client a stack trace runs through when the port is unknown', () => {
    const text = [
      'Error: connect ECONNREFUSED 127.0.0.1:7000',
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)',
      '    at Socket.<anonymous> (/repo/node_modules/ioredis/built/Redis.js:170:41)'
    ].join('\n')
    expect(unreachableServiceInText(text)).toBe('Redis')
  })

  it('falls back to the service on a local port, never to localhost alone', () => {
    expect(unreachableServiceInText('Error: connect ECONNREFUSED 127.0.0.1:8081')).toBe('the service on :8081')
    expect(unreachableServiceInText('curl: (7) Failed to connect to localhost port 4000: Connection refused')).toBe(
      'the service on :4000'
    )
    expect(unreachableServiceInText('Connection refused (localhost)')).toBeNull()
  })

  it('falls back to a remote host and port, or a host that did not resolve', () => {
    expect(unreachableServiceInText('Error: connect ECONNREFUSED 10.0.0.9:8443')).toBe('10.0.0.9:8443')
    expect(unreachableServiceInText('FetchError: request to https://api.example.com/v1 failed, reason: getaddrinfo ENOTFOUND api.example.com')).toBe(
      'api.example.com'
    )
    expect(unreachableServiceInText('curl: (6) Could not resolve host: payments.internal')).toBe('payments.internal')
  })

  it('does not read file:line or a clock time as an endpoint', () => {
    expect(unreachableServiceInText('12:30 connection refused at server.ts:120')).toBeNull()
  })

  it('ignores package registries and code hosts', () => {
    expect(unreachableServiceInText('npm ERR! request to https://registry.npmjs.org/x failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org')).toBeNull()
    expect(unreachableServiceInText("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com")).toBeNull()
  })

  it('shows nothing when no connection failed', () => {
    expect(unreachableServiceInText('Expected 2, received 3 at tests/search.test.ts:12:5')).toBeNull()
    expect(unreachableServiceInText('Listening on 127.0.0.1:6379')).toBeNull()
    expect(unreachableServiceInText('')).toBeNull()
    expect(unreachableServiceInText(undefined)).toBeNull()
  })
})

function terminal(id: string, content: string, status: 'done' | 'fail' = 'done'): UiItem {
  return { kind: 'tool', id, tool: { id, name: 'terminal', summary: 'pnpm test', status, content } }
}

describe('unreachableServiceInTurn', () => {
  const user = (id: string, content: string): UiItem => ({ kind: 'message', id, role: 'user', content })
  const runError = (message: string, code?: string): UiItem => ({ kind: 'run_error', id: 'err', message, ...(code ? { code } : {}) })

  it('reads a failed command in the latest turn', () => {
    const items = [
      user('u1', 'Cache search results'),
      terminal('t1', 'cwd: /ws\n\nstderr:\nError: connect ECONNREFUSED 127.0.0.1:6379\nexit_code: 1'),
      runError('The tests could not run.', 'AGENT_LOOP')
    ]
    expect(unreachableServiceInTurn(items)).toBe('Redis')
  })

  it('reads the error first, then the newest failed command', () => {
    const items = [
      user('u1', 'go'),
      terminal('t1', 'cwd: /ws\n\nError: connect ECONNREFUSED 127.0.0.1:6379\nexit_code: 1'),
      terminal('t2', 'cwd: /ws\n\nError: connect ECONNREFUSED 127.0.0.1:5432\nexit_code: 1'),
      runError('Stopped: MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017')
    ]
    expect(unreachableServiceInTurn(items)).toBe('MongoDB')
    expect(unreachableServiceInTurn(items.slice(0, 3))).toBe('Postgres')
  })

  it('skips commands that passed and turns before the last thing sent', () => {
    const passed = [user('u1', 'go'), terminal('t1', 'cwd: /ws\n\nretrying: connect ECONNREFUSED 127.0.0.1:6379\nok\nexit_code: 0')]
    expect(unreachableServiceInTurn(passed)).toBeNull()
    const earlier = [
      user('u1', 'go'),
      terminal('t1', 'Error: connect ECONNREFUSED 127.0.0.1:6379', 'fail'),
      user('u2', 'try again'),
      runError('Something else broke', 'AGENT_LOOP')
    ]
    expect(unreachableServiceInTurn(earlier)).toBeNull()
  })

  it('does not read the agent’s own model connection as the task’s', () => {
    const items = [user('u1', 'go'), runError('connect ECONNREFUSED 127.0.0.1:11434', 'PROVIDER_NETWORK')]
    expect(unreachableServiceInTurn(items)).toBeNull()
  })
})

describe('mockServiceInstruction', () => {
  it('asks to mock it and carry on', () => {
    expect(mockServiceInstruction('Redis')).toBe(
      'Mock Redis instead of connecting to it, so the work can be verified without it, then carry on.'
    )
  })
})
