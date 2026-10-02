import { describe, expect, it } from 'vitest'
import { inflateRawSync } from 'zlib'
import {
  buildDiagnosticsZip,
  diagnosticsFileName,
  logTail,
  redactDiagnosticsText,
  redactDiagnosticsValue,
  type RedactionContext
} from '@main/diagnostics/bundle'
import { createZip } from '@main/diagnostics/zip'
import { readZipEntry } from '@main/agent/tools/docxText'

const ctx: RedactionContext = { home: 'C:\\Users\\Jane Doe', username: 'Jane Doe' }
const posixCtx: RedactionContext = { home: '/home/jdoe', username: 'jdoe' }

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'

/** Every entry of a zip, by name: walks the central directory like an unzip tool would. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = buf.readUInt16LE(end + 10)
  let at = buf.readUInt32LE(end + 16)
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50)
    const method = buf.readUInt16LE(at + 10)
    const size = buf.readUInt32LE(at + 20)
    const nameLen = buf.readUInt16LE(at + 28)
    const local = buf.readUInt32LE(at + 42)
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8')
    const localNameLen = buf.readUInt16LE(local + 26)
    const body = buf.subarray(local + 30 + localNameLen, local + 30 + localNameLen + size)
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString('utf8'))
    at += 46 + nameLen
  }
  return out
}

describe('diagnostics redaction', () => {
  it('takes keys, the home folder and the username out of text', () => {
    const line =
      `[2026-10-02 12:00:00] [info] opened C:\\Users\\Jane Doe\\AppData\\Roaming\\vyotiq\\logs\\vyotiq.log ` +
      `key=${KEY} Authorization: Bearer abcdefghijklmnopqrstuvwxyz owner Jane Doe`
    const out = redactDiagnosticsText(line, ctx)
    expect(out).toContain('~\\AppData\\Roaming\\vyotiq\\logs\\vyotiq.log')
    expect(out).not.toContain('Jane')
    expect(out).not.toContain(KEY)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(out).toContain('owner <user>')
  })

  it('handles POSIX homes, git-bash paths and other users’ absolute paths', () => {
    const out = redactDiagnosticsText('cwd /home/jdoe/src/app; also /c/Users/jdoe/x and /Users/other/secret-project/a.ts', posixCtx)
    expect(out).toContain('~/src/app')
    expect(out).not.toMatch(/jdoe/)
    expect(out).not.toContain('/Users/other')
  })

  it('redacts settings: every env and header value, secret-named fields, paths under home', () => {
    const settings = {
      provider: 'anthropic',
      model: 'claude',
      theme: 'dark',
      mcpServers: [
        {
          name: 'db',
          command: 'node',
          args: ['C:\\Users\\Jane Doe\\mcp\\server.js', `--token=${GH}`],
          env: { DATABASE_URL: 'postgres://jane:hunter2@db.local/prod', PLAIN: 'not-a-secret-shape' },
          headers: { 'X-Org': 'acme-internal' }
        }
      ],
      customProviders: [{ slug: 'gw', baseUrl: 'https://gw.example', headers: { 'X-Tenant': 'tenant-42' } }],
      githubToken: GH,
      workspaces: ['C:\\Users\\Jane Doe\\Documents\\proj']
    }
    const before = JSON.stringify(settings)
    const out = JSON.stringify(redactDiagnosticsValue(settings, ctx))
    expect(JSON.stringify(settings)).toBe(before) // input untouched
    for (const leaked of ['hunter2', 'not-a-secret-shape', 'acme-internal', 'tenant-42', GH, 'Jane']) {
      expect(out).not.toContain(leaked)
    }
    const parsed = JSON.parse(out) as {
      provider: string
      mcpServers: Array<{ env: Record<string, string>; headers: Record<string, string>; args: string[] }>
      githubToken: string
      workspaces: string[]
    }
    expect(parsed.provider).toBe('anthropic')
    expect(parsed.mcpServers[0]!.env).toEqual({ DATABASE_URL: '[redacted]', PLAIN: '[redacted]' })
    expect(parsed.mcpServers[0]!.headers).toEqual({ 'X-Org': '[redacted]' })
    expect(parsed.githubToken).toBe('[redacted]')
    expect(parsed.workspaces).toEqual(['~\\Documents\\proj'])
    expect(parsed.mcpServers[0]!.args[0]).toBe('~\\mcp\\server.js')
  })

  it('keeps the end of a long log, from a whole line', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n')
    const tail = logTail(lines, 10_000)
    expect(Buffer.byteLength(tail)).toBeLessThan(10_200)
    expect(tail.startsWith('[… earlier lines left out')).toBe(true)
    expect(tail.split('\n')[1]).toMatch(/^line \d+ x+$/)
    expect(tail.endsWith('line 4999 ' + 'x'.repeat(40))).toBe(true)
    expect(logTail('short', 10_000)).toBe('short')
  })
})

describe('diagnostics bundle', () => {
  const now = new Date(2026, 9, 2, 14, 30)

  it('is a zip of README, system, settings, crashes, perf and the logs, all redacted', () => {
    const { zip, files } = buildDiagnosticsZip({
      now,
      system: { appVersion: '1.1.0', os: 'Windows_NT 10.0.26300', arch: 'x64', electron: '44.4.5', node: '24.19.0' },
      settings: { provider: 'openai', apiKey: KEY, mcpServers: [{ name: 'x', env: { TOKEN: 'abc' } }] },
      crashes: { snippets: [{ at: '2026-10-01T10:00:00.000Z', kind: 'renderer', reason: 'oom' }], pendingRecovery: null },
      perf: { processes: { totalWorkingSetMb: 812 }, load: { unavailable: 'not started' } },
      logs: [
        { name: 'vyotiq.log', text: `[info] started in C:\\Users\\Jane Doe\\proj with ${KEY}\n` },
        { name: 'vyotiq.old.log', text: '[warn] older line\n' }
      ],
      ctx
    })
    expect(files).toEqual([
      'README.txt',
      'system.json',
      'settings.json',
      'crashes.json',
      'perf.json',
      'logs/vyotiq.log',
      'logs/vyotiq.old.log'
    ])
    const entries = unzip(zip)
    expect([...entries.keys()]).toEqual(files)
    expect(JSON.parse(entries.get('system.json')!)).toMatchObject({ appVersion: '1.1.0', electron: '44.4.5', node: '24.19.0' })
    expect(JSON.parse(entries.get('settings.json')!)).toMatchObject({ provider: 'openai', apiKey: '[redacted]' })
    expect(JSON.parse(entries.get('perf.json')!)).toMatchObject({ processes: { totalWorkingSetMb: 812 } })
    expect(JSON.parse(entries.get('crashes.json')!).snippets[0]).toMatchObject({ kind: 'renderer', reason: 'oom' })
    expect(entries.get('logs/vyotiq.log')).toBe('[info] started in ~\\proj with [redacted]\n')
    expect(entries.get('README.txt')).toContain('logs/vyotiq.old.log')
    for (const text of entries.values()) {
      expect(text).not.toContain('Jane')
      expect(text).not.toContain(KEY)
      expect(text).not.toContain('"abc"')
    }
    // The app's own zip reader agrees.
    expect(readZipEntry(zip, 'system.json').toString('utf8')).toBe(entries.get('system.json'))
  })

  it('writes entries a standard reader can open, stored or deflated', () => {
    const zip = createZip([
      { name: 'tiny.txt', data: Buffer.from('a') },
      { name: 'dir/big.txt', data: Buffer.from('repeat '.repeat(2000)) },
      { name: 'ünïcode.txt', data: Buffer.from('ok') }
    ])
    const entries = unzip(zip)
    expect(entries.get('tiny.txt')).toBe('a')
    expect(entries.get('dir/big.txt')).toBe('repeat '.repeat(2000))
    expect(entries.get('ünïcode.txt')).toBe('ok')
    expect(zip.length).toBeLessThan(2000)
  })

  it('names the file by local date and time', () => {
    expect(diagnosticsFileName(now)).toBe('vyotiq-diagnostics-20261002-1430.zip')
  })
})
