import { formatWithOptions } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  sanitizeLogFields,
  sanitizeLogMessage,
  LOG_MESSAGE_TEXT_CAP
} from '@shared/logPolicy'
import { getLoggerBackend, logger, markTruncatedLogText, setLoggerBackend } from '@shared/logger'

/** Suffix markTruncatedLogText appends. Regex, not literal, so the number is free. */
const MARK = /\[\+truncated: \d+ chars?\]/

const TS = '[2026-09-28 21:04:32.901]'

/**
 * Reproduce what electron-log's file transport writes for one record, from the
 * transform chain it actually runs (node_modules/electron-log):
 *
 *  - `transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}'`
 *    (src/node/transports/file/index.js)
 *  - formatVariables: `{level}]` -> `` `${level}]`.padEnd(6) `` — the pad space
 *    lands INSIDE the bracket block, so `[info] ` is 7 chars and `[error]` 6.
 *  - formatScope: `{scope}` -> '' (no electron-log scope is ever set by init.ts).
 *  - formatText: `{text}` is at the tail, so `\s?{text}` is dropped.
 *  - concatFirstStringElements: rejoins the two leading strings with ONE space.
 *  - node/transforms/object.js `toString`: util.formatWithOptions over the rest.
 *
 * init.ts folds scope + correlationId into the message text and destructures
 * them out of the field object, so the on-disk shape is
 * `[ts] [info]  [main] {cid} MESSAGE { key: 'value' }`.
 */
function fileHead(level = 'info'): string {
  return `${TS} [${`${level}]`.padEnd(6, ' ')}`
}

function renderLine(
  message: string,
  fields?: Record<string, unknown>,
  opts: { level?: string } = {}
): string {
  const level = opts.level ?? 'info'
  const scope = typeof fields?.scope === 'string' ? fields.scope : ''
  const cid = typeof fields?.correlationId === 'string' ? fields.correlationId : ''
  const line = `${scope ? `[${scope}] ` : ''}${cid ? `{${cid}} ` : ''}${message}`
  const { scope: _s, correlationId: _c, ...meta } = fields ?? {}
  const tail = Object.keys(meta).length > 0 ? ` ${formatWithOptions({ depth: 5 }, meta)}` : ''
  return `${fileHead(level)}${line}${tail}`
}

/**
 * Everything electron-log writes before the message text: the 25-char
 * timestamp, the space, `[` + `` `${level}]`.padEnd(6) ``, and the single space
 * that formatText leaves behind after dropping `\s?{text}`.
 */
const FILE_PREFIX_CHARS = fileHead().length
/** `[main] ` — init.ts's scope prefix for the busiest scope in the app. */
const SCOPE_PREFIX = '[main] '.length

function backendMessage(
  message: string,
  fields?: Record<string, unknown>
): { message: string; fields?: Record<string, unknown> } {
  const calls: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const previous = getLoggerBackend()
  setLoggerBackend({
    log: (_level, msg, f) => {
      calls.push({ message: msg, fields: f as Record<string, unknown> | undefined })
    }
  })
  try {
    logger.info(message, fields)
  } finally {
    setLoggerBackend(previous)
  }
  expect(calls).toHaveLength(1)
  return calls[0]!
}

afterEach(() => setLoggerBackend(getLoggerBackend()))

describe('D1: a rendered line over the cap carries a truncation marker', () => {
  it('leaves a short entry byte-identical (no marker, no re-wrap)', () => {
    const message = 'Code index warm sync'
    const fields = { scope: 'workspaceIndex', scanned: 1200, indexed: 3 }

    const marked = markTruncatedLogText(message, fields)

    expect(marked).toBe(message)
    expect(marked).not.toMatch(MARK)
    expect(renderLine(marked, fields).length).toBeLessThanOrEqual(LOG_MESSAGE_TEXT_CAP)
  })

  it('leaves an entry that exactly hits the boundary unmarked', () => {
    const message = 'm'.repeat(LOG_MESSAGE_TEXT_CAP - FILE_PREFIX_CHARS - SCOPE_PREFIX)
    const fields = { scope: 'main' }

    expect(renderLine(message, fields).length).toBe(LOG_MESSAGE_TEXT_CAP)

    const marked = markTruncatedLogText(message, fields)

    expect(marked).toBe(message)
    expect(renderLine(marked, fields).length).toBe(LOG_MESSAGE_TEXT_CAP)
    expect(marked).not.toMatch(MARK)
  })

  it('marks a rendered line exactly one character over the cap, reporting the hidden count', () => {
    const message = 'm'.repeat(LOG_MESSAGE_TEXT_CAP - FILE_PREFIX_CHARS - SCOPE_PREFIX + 1)
    const fields = { scope: 'main' }

    expect(renderLine(message, fields).length).toBe(LOG_MESSAGE_TEXT_CAP + 1)

    const marked = markTruncatedLogText(message, fields)

    expect(marked).not.toBe(message)
    expect(marked).toMatch(MARK)
    expect(marked).toMatch(/\[\+truncated: 1 char\]$/)
  })

  it('marks a short message that only goes over the cap by field accumulation', () => {
    // The measured defect shape: prefix + short message + several fields. No
    // individual part is over the cap, so nothing is cut and nothing is marked,
    // yet the rendered line is 240+ chars — indistinguishable from a complete
    // entry to anyone reading the file.
    const message = 'MCP server connected'
    const fields = {
      scope: 'mcp',
      serverId: 'srv-9f2a11c7d4e0',
      transport: 'stdio',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      status: 'connected',
      generation: 41207,
      argsKeys: 'command,block_until_ms,cwd,timeoutMs',
      source: 'workspace-settings'
    }
    for (const value of Object.values(fields)) {
      expect(String(value).length).toBeLessThan(LOG_MESSAGE_TEXT_CAP)
    }

    const unmarked = renderLine(message, fields)
    expect(unmarked.length).toBeGreaterThan(LOG_MESSAGE_TEXT_CAP)
    expect(unmarked).not.toMatch(MARK)

    const marked = markTruncatedLogText(message, fields)
    const rendered = renderLine(marked, fields)

    expect(marked).toMatch(MARK)
    expect(rendered).toMatch(MARK)
  })

  it('marks a line whose single field is itself over-long, keeping that field own ellipsis', () => {
    // sanitizeLogMessage already cut this value to 237 + '...'. The line marker
    // is additive: it must not replace, drop or duplicate the per-string cut.
    const longField = sanitizeLogMessage(`detail: ${'d'.repeat(300)}`)
    expect(longField).toHaveLength(LOG_MESSAGE_TEXT_CAP)
    expect(longField.endsWith('...')).toBe(true)

    const fields = { scope: 'provider', providerMessage: longField }
    const message = 'Retrying provider request'

    // The field alone puts the line over the cap — the defect in its purest form.
    expect(renderLine(message, fields).length).toBeGreaterThan(LOG_MESSAGE_TEXT_CAP)

    const marked = markTruncatedLogText(message, fields)

    expect(marked).toMatch(MARK)
    // The marker rides the message text; electron-log renders the fields after
    // {text}, so the field value with its own ellipsis is still on the line.
    const rendered = renderLine(marked, fields)
    expect(rendered).toContain(longField)
    expect(rendered).toContain('detail: ')
  })

  it('marks through the logger facade, so the line that reaches disk is self-describing', () => {
    const fields = {
      scope: 'mcp',
      serverId: 'srv-9f2a11c7d4e0',
      transport: 'stdio',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      status: 'connected',
      generation: 41207,
      argsKeys: 'command,block_until_ms,cwd,timeoutMs',
      source: 'workspace-settings'
    }

    const call = backendMessage('MCP server connected', fields)
    const rendered = renderLine(call.message, call.fields)

    expect(rendered.length).toBeGreaterThan(LOG_MESSAGE_TEXT_CAP)
    expect(rendered).toMatch(MARK)
  })

  it('leaves a facade line under the cap untouched, message byte for byte', () => {
    const call = backendMessage('Code index warm sync', { scope: 'workspaceIndex', scanned: 1200 })

    expect(call.message).toBe('Code index warm sync')
    expect(renderLine(call.message, call.fields).length).toBeLessThanOrEqual(LOG_MESSAGE_TEXT_CAP)
  })
})

describe('sanitizeLogMessage contract is byte-identical to before', () => {
  it('still cuts one string at 240 and leaves 240 intact', () => {
    const exact = 'm'.repeat(LOG_MESSAGE_TEXT_CAP)
    const over = 'm'.repeat(LOG_MESSAGE_TEXT_CAP + 1)

    expect(sanitizeLogMessage(exact)).toBe(exact)
    expect(sanitizeLogMessage(over)).toBe(`${'m'.repeat(LOG_MESSAGE_TEXT_CAP - 3)}...`)
    expect(sanitizeLogMessage(over)).toHaveLength(LOG_MESSAGE_TEXT_CAP)
  })

  it('still collapses a multi-line message to one line', () => {
    // A diff hunk's expected-context preview must never become untagged log
    // lines, which would put file content in the log as if it were telemetry.
    expect(sanitizeLogMessage('patch failed:\n  - const a = 1\n  + const a = 2\n')).toBe(
      'patch failed: - const a = 1 + const a = 2'
    )
  })

  it('still redacts user paths, relative paths, secrets and user-data-prefixed text', () => {
    expect(sanitizeLogMessage('File not found: C:\\Users\\me\\src\\auth.ts')).toBe(
      'File not found: [redacted]'
    )
    expect(sanitizeLogMessage('read src/payroll.ts here')).toBe('read [path] here')
    expect(sanitizeLogMessage('bad key sk-abcdefghijklmnop')).toBe('bad key [redacted]')
    expect(sanitizeLogMessage('Path is a directory: C:\\Users\\me\\ws')).toBe(
      'Path is a directory: [redacted]'
    )
  })

  it('produces identical scrubbed text whether or not the marker is applied', () => {
    // USER_DATA_PREFIX collapses the entire remainder of a user-data-prefixed
    // message, so only the label survives — the whole point of that rule.
    const prefixed = sanitizeLogMessage('File not found: C:\\Users\\me\\src\\auth.ts')
    expect(prefixed).toBe('File not found: [redacted]')
    expect(markTruncatedLogText(prefixed, { scope: 'main' })).toBe(prefixed)

    const raw = 'tool read failed for C:\\Users\\me\\ws\\a.ts with sk-abcdefghijklmnop'
    const scrubbed = sanitizeLogMessage(raw)

    // Established scrubPath semantics, asserted separately by
    // tests/shared/errorsLogging.test.ts: an absolute path is reduced to its
    // basename by scrubString before the [path] rules can ever see it. What
    // must not survive is the directory chain or the secret.
    expect(scrubbed).toContain('[redacted]')
    expect(scrubbed).not.toContain('sk-abcdefghijklmnop')
    expect(scrubbed).not.toContain('Users')
    expect(scrubbed).not.toContain('ws')
    // Marking is measurement on top of an already-scrubbed string, so a short
    // line passes through byte-identically.
    expect(markTruncatedLogText(scrubbed, { scope: 'main' })).toBe(scrubbed)
  })

  it('scrubs identically through the facade and through markTruncatedLogText on a long line', () => {
    const raw =
      `tool read failed for C:\\Users\\me\\workspace\\aether\\agentsd\\src\\config.rs ` +
      `with sk-ant-abcdefghijklmnop ${'x'.repeat(200)}`
    const fields = { scope: 'agent', tool: 'read', code: 'TOOL_EXEC' }

    const call = backendMessage(raw, fields)
    const marked = markTruncatedLogText(sanitizeLogMessage(raw), fields)

    expect(call.message).toBe(marked)
    expect(call.message).toMatch(MARK)
    expect(call.message).toContain('[redacted]')
    expect(call.message).not.toContain('sk-ant-abcdefghijklmnop')
    expect(call.message).not.toContain('Users')
    expect(call.message).not.toContain('workspace')
    expect(call.message).not.toContain('aether/agentsd')
  })

  it('still redacts a secret-shaped string on a line long enough to trigger the marker', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const raw = `provider auth failed: token=${secret} ${'padding '.repeat(40)}`
    const fields = { scope: 'provider' }

    const call = backendMessage(raw, fields)

    expect(renderLine(call.message, call.fields).length).toBeGreaterThan(LOG_MESSAGE_TEXT_CAP)
    expect(call.message).toMatch(MARK)
    expect(call.message).not.toContain(secret)
    expect(call.message).toContain('[redacted]')
    // scrubString's `token["']?\s*[:=]…` pattern consumes the `token=` label
    // along with the value, and it runs before any length check — so the marker
    // can never expose a prefix of what it replaced.
    expect(call.message.startsWith('provider auth failed: [redacted] padding')).toBe(true)
  })

  it('sanitizeLogFields still drops forbidden keys and keeps counters', () => {
    const out = sanitizeLogFields({
      scope: 'workspaceIndex',
      workspace: 'C:\\Users\\me\\secret-project',
      scanned: 1200,
      cursor: 'src/payroll.ts',
      'src/payroll.ts': 3
    }) as Record<string, unknown>

    expect(out).toEqual({ scope: 'workspaceIndex', scanned: 1200 })
  })
})

describe('the marker never under-reports: no over-cap line escapes unmarked', () => {
  it('marks every case whose real rendered line is over the cap', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['msg', { scope: 'main' }],
      ['msg', { scope: 'main', code: 'X'.repeat(200) }],
      ['msg', { scope: 'main', pad: 'p'.repeat(220) }],
      ['m'.repeat(120), { scope: 'agent', tool: 'terminal', stopReason: 'empty_response' }],
      [
        'Provider request failed',
        {
          scope: 'provider',
          providerMessage: sanitizeLogMessage('x'.repeat(260)),
          model: 'openai/gpt-5.6-luna-pro'
        }
      ],
      ['msg', { scope: 'main', err: { name: 'TypeError', message: 'y'.repeat(180) } }]
    ]

    for (const [message, fields] of cases) {
      const real = renderLine(message, fields).length
      const marked = markTruncatedLogText(message, fields)
      if (real > LOG_MESSAGE_TEXT_CAP) {
        expect(marked, `rendered ${real} chars, must be marked`).toMatch(MARK)
      } else {
        expect(marked).toBe(message)
      }
    }
  })

  it('reports a hidden-character count that is never below the real overflow', () => {
    for (let n = 1; n <= 60; n += 1) {
      const fields = { scope: 'main', pad: 'p'.repeat(n) }
      const real = renderLine('msg', fields).length
      const marked = markTruncatedLogText('msg', fields)
      if (!marked.includes('[+truncated')) continue
      const reported = Number(/\[\+truncated: (\d+) chars?\]/.exec(marked)?.[1] ?? '-1')
      expect(reported).toBeGreaterThanOrEqual(real - LOG_MESSAGE_TEXT_CAP)
    }
  })
})