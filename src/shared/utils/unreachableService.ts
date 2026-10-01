import type { UiItem, UiToolRow } from '../domain/transcript'
import { parseTerminalOutput } from './terminalFormat'

/**
 * What a failed task could not reach, read from its own words: the turn's
 * error and the output of the commands that failed. Deterministic on purpose —
 * the record offers "Ask it to mock <name>" from it, and a guess would put a
 * wrong name on a button.
 *
 * A name comes from a well-known port first (the port is what actually
 * refused), then from a client named in the message ("Redis connection",
 * ioredis, psycopg), then from the endpoint itself. Localhost alone is not a
 * name: an unknown local port reads "the service on :PORT".
 */

/** A line that says a connection to something failed. */
const CONNECT_FAILURE = new RegExp(
  [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'getaddrinfo',
    'connect ETIMEDOUT',
    'connection refused',
    "(?:could not|couldn't|can't|cannot|unable to|failed to) connect to",
    'error connecting to',
    'error \\d+ connecting to',
    'connection to .{0,120}?(?:refused|failed)',
    'actively refused',
    'name or service not known',
    'nodename nor servname',
    'temporary failure in name resolution',
    'no such host',
    'could not resolve host',
    'MongoServerSelectionError',
    'MongoNetworkError'
  ].join('|'),
  'i'
)

/** Ports whose service is unambiguous. */
const PORT_NAMES: Readonly<Record<number, string>> = {
  6379: 'Redis',
  5432: 'Postgres',
  3306: 'MySQL',
  27017: 'MongoDB',
  9200: 'Elasticsearch',
  5672: 'RabbitMQ',
  11211: 'Memcached',
  2181: 'ZooKeeper',
  9092: 'Kafka',
  4222: 'NATS',
  9042: 'Cassandra',
  1433: 'SQL Server',
  1521: 'Oracle',
  26257: 'CockroachDB',
  7687: 'Neo4j',
  8086: 'InfluxDB',
  2379: 'etcd',
  8500: 'Consul',
  8123: 'ClickHouse',
  6333: 'Qdrant',
  19530: 'Milvus',
  7700: 'Meilisearch',
  4566: 'LocalStack'
}

/** Clients and servers named in an error message, most specific first. */
const CLIENT_NAMES: readonly (readonly [RegExp, string])[] = [
  [/\bredis|ioredis/i, 'Redis'],
  [/postgres|psycopg|asyncpg|PSQLException|\bpsql\b|\bpg\b/i, 'Postgres'],
  [/mysql|mariadb/i, 'MySQL'],
  [/mongo/i, 'MongoDB'],
  [/elasticsearch/i, 'Elasticsearch'],
  [/opensearch/i, 'OpenSearch'],
  [/rabbitmq|amqplib|\bamqps?\b/i, 'RabbitMQ'],
  [/memcache/i, 'Memcached'],
  [/kafka/i, 'Kafka'],
  [/zookeeper/i, 'ZooKeeper'],
  [/\bnats\b/i, 'NATS'],
  [/cassandra/i, 'Cassandra'],
  [/\bmssql\b|sql server|\btedious\b/i, 'SQL Server'],
  [/clickhouse/i, 'ClickHouse'],
  [/neo4j/i, 'Neo4j'],
  [/\betcd\b/i, 'etcd'],
  [/\bconsul\b/i, 'Consul'],
  [/localstack/i, 'LocalStack']
]

/**
 * Hosts a task fetches its tools from, not hosts it depends on: an offline
 * `npm install` is not something to mock.
 */
const TOOLING_HOSTS: readonly string[] = [
  'npmjs.org',
  'npmjs.com',
  'yarnpkg.com',
  'pypi.org',
  'pythonhosted.org',
  'github.com',
  'githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'golang.org',
  'crates.io',
  'rubygems.org',
  'maven.org',
  'apache.org',
  'gradle.org',
  'nuget.org',
  'docker.io',
  'docker.com',
  'debian.org',
  'ubuntu.com',
  'alpinelinux.org',
  'nodejs.org',
  'jsdelivr.net',
  'unpkg.com'
]

/** Source files a stack trace names as `file.ext:line`, which are not hosts. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|rs|php|cs|swift|scala|ex|exs|c|cc|cpp|h)$/i

/** host:port — an IPv4 or bracketed IPv6 address, ::1, or a hostname. */
const HOST_PORT =
  /(?<![\w.:/-])(\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|::1|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):(\d{2,5})(?![\d:])/gi
/** A URL's authority: redis://user@host:port. */
const URL_HOST_PORT = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@\s/]*@)?([^\s/:'"]+):(\d{2,5})(?!\d)/gi
/** "… on port 5432" (libpq, and others that split host and port). */
const BARE_PORT = /\bport\s+(\d{2,5})\b/i
/** The host a lookup could not resolve. */
const UNRESOLVED_HOST = /\b(?:ENOTFOUND|EAI_AGAIN|could not resolve host:?)\s+([a-z0-9][a-z0-9.-]*[a-z0-9])/i

type Endpoint = { host: string | null; port: number }

/** A stack frame: "at fn (file:1:2)", Python's 'File "x", line 3'. */
function isFrame(line: string): boolean {
  return /^\s*(?:at\s|File\s")/.test(line)
}

function isLocalHost(host: string | null): boolean {
  if (!host) return true
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === 'host.docker.internal' || /^127\./.test(h)
}

function isToolingHost(host: string): boolean {
  const h = host.toLowerCase()
  return TOOLING_HOSTS.some((t) => h === t || h.endsWith(`.${t}`))
}

function endpointsIn(text: string): Endpoint[] {
  const out: Endpoint[] = []
  for (const m of text.matchAll(URL_HOST_PORT)) out.push({ host: m[1]!, port: Number(m[2]) })
  for (const m of text.matchAll(HOST_PORT)) {
    const host = m[1]!
    // A file:line in a trace, or a clock time, is not an endpoint.
    if (CODE_FILE.test(host) || /^\d+$/.test(host)) continue
    out.push({ host, port: Number(m[2]) })
  }
  const bare = BARE_PORT.exec(text)
  if (bare) out.push({ host: null, port: Number(bare[1]) })
  return out.filter((e) => e.port > 0 && e.port <= 65535)
}

function clientNameIn(text: string): string | null {
  for (const [pattern, name] of CLIENT_NAMES) if (pattern.test(text)) return name
  return null
}

/** The name for the failure on `lines[i]`, read from that line and its neighbours. */
function nameAround(lines: readonly string[], i: number): string | null {
  const line = lines[i]!
  const near = lines.slice(Math.max(0, i - 2), i + 3).filter((l) => !isFrame(l))
  const nearText = near.join('\n')
  const unresolved = UNRESOLVED_HOST.exec(line)?.[1] ?? null
  if (unresolved && isToolingHost(unresolved)) return null

  // The port is what refused: it outranks a client named in passing.
  for (const scope of [line, nearText]) {
    const known = endpointsIn(scope).find((e) => PORT_NAMES[e.port] && !(e.host && isToolingHost(e.host)))
    if (known) return PORT_NAMES[known.port]!
  }
  for (const scope of [line, nearText]) {
    const named = clientNameIn(scope)
    if (named) return named
  }
  // The client the trace runs through: node_modules/ioredis/…, org.postgresql…,
  // site-packages/redis/… — after the error in Node and Java, before it in Python.
  const frames = lines.slice(Math.max(0, i - 12), i + 13).filter(isFrame)
  const fromFrames = clientNameIn(frames.join('\n'))
  if (fromFrames) return fromFrames

  const endpoint = endpointsIn(line)[0] ?? endpointsIn(nearText)[0] ?? null
  if (endpoint) {
    if (endpoint.host && isToolingHost(endpoint.host)) return null
    if (isLocalHost(endpoint.host)) return `the service on :${endpoint.port}`
    return `${endpoint.host}:${endpoint.port}`
  }
  if (unresolved && !isLocalHost(unresolved)) return unresolved
  return null
}

/**
 * The name of what a piece of output could not connect to, or null when it
 * shows no connection failure, or one with nothing to call it by.
 */
export function unreachableServiceInText(text: string | null | undefined): string | null {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    if (!CONNECT_FAILURE.test(lines[i]!)) continue
    const name = nameAround(lines, i)
    if (name) return name
  }
  return null
}

/**
 * Errors about the agent's own connections — to its model, or to an MCP
 * server — not about anything the task needed.
 */
function isAgentSideCode(code: string | undefined): boolean {
  return Boolean(code && (code.startsWith('PROVIDER_') || code.startsWith('MCP_') || code === 'CIRCUIT_OPEN'))
}

function commandFailed(tool: UiToolRow): boolean {
  if (tool.status === 'fail') return true
  if (tool.status !== 'done' || !tool.content) return false
  const exit = parseTerminalOutput(tool.content).exitCode
  return exit != null && exit !== 0
}

/**
 * What the latest turn could not reach: its error first, then the commands
 * that failed in it, newest first. Read back to the last thing you sent.
 */
export function unreachableServiceInTurn(items: readonly UiItem[]): string | null {
  const texts: string[] = []
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.kind === 'message' && item.role === 'user') break
    if (item.kind === 'run_error') {
      if (!isAgentSideCode(item.code)) texts.unshift(item.message)
    } else if (item.kind === 'tool' && item.tool.name === 'terminal' && commandFailed(item.tool)) {
      texts.push(item.tool.content ?? '')
    }
  }
  for (const text of texts) {
    const name = unreachableServiceInText(text)
    if (name) return name
  }
  return null
}

/** The follow-up the record sends when you ask it to mock what it could not reach. */
export function mockServiceInstruction(name: string): string {
  return `Mock ${name} instead of connecting to it, so the work can be verified without it, then carry on.`
}
