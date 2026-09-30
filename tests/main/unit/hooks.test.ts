import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-hooks-ud-'))
vi.mock('electron', () => ({ app: { getPath: (n: string) => (n === 'userData' ? userData : tmpdir()) } }))

import { loadRunHooks, readHooksFile, resetHooksForTests, runHookCommand } from '@main/agent/hooks'

let ws: string
let scripts: string

/** A hook script: logs its stdin to `log`, prints `stderr`, exits `code`. */
function script(name: string, code: number, stderr = ''): string {
  const file = join(scripts, `${name}.cjs`)
  writeFileSync(
    file,
    `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{require('fs').appendFileSync(${JSON.stringify(join(scripts, 'log.jsonl'))}, s+'\\n');process.stderr.write(${JSON.stringify(stderr)});process.exit(${code})})`
  )
  return `node "${file}"`
}

function logged(): Array<Record<string, unknown>> {
  const file = join(scripts, 'log.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
}

function writeHooks(path: string, hooks: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify({ hooks }), 'utf8')
}

beforeEach(() => {
  resetHooksForTests()
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-hooks-ws-'))
  scripts = mkdtempSync(join(tmpdir(), 'vyotiq-hooks-sh-'))
  rmSync(join(userData, 'hooks.json'), { force: true })
  rmSync(join(userData, 'hook-trust.json'), { force: true })
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(scripts, { recursive: true, force: true })
})

describe('hooks', () => {
  it('runs a command with its JSON on stdin and reports exit code and stderr', async () => {
    const run = await runHookCommand(script('h', 2, 'nope'), { hook_event_name: 'PreToolUse', tool_name: 'terminal' }, { cwd: ws, timeoutMs: 20_000 })
    expect(run).toMatchObject({ code: 2, stderr: 'nope', timedOut: false })
    expect(logged()).toEqual([{ hook_event_name: 'PreToolUse', tool_name: 'terminal' }])
  }, 30_000)

  it('stops a hook that runs past its timeout', async () => {
    const run = await runHookCommand('node -e "setTimeout(()=>{}, 60000)"', {}, { cwd: ws, timeoutMs: 1_000 })
    expect(run.timedOut).toBe(true)
  }, 30_000)

  it('blocks a matching tool with exit 2, and leaves other tools alone', async () => {
    writeHooks(join(userData, 'hooks.json'), {
      PreToolUse: [{ matcher: 'terminal|edit', hooks: [{ type: 'command', command: script('guard', 2, 'no shell today') }] }]
    })
    const hooks = await loadRunHooks(ws, 'run-1', null)
    expect(await hooks.preToolUse('terminal', { command: 'ls' })).toBe('no shell today')
    expect(await hooks.preToolUse('read', { path: 'a' })).toBeNull()
    expect(logged()).toEqual([
      { session_id: 'run-1', cwd: ws, hook_event_name: 'PreToolUse', tool_name: 'terminal', tool_input: { command: 'ls' } }
    ])
  }, 30_000)

  it('hands PostToolUse feedback and Stop reasons back, and ignores other failures', async () => {
    writeHooks(join(userData, 'hooks.json'), {
      PostToolUse: [{ hooks: [{ type: 'command', command: script('lint', 2, 'lint: 2 errors') }] }],
      Stop: [
        { hooks: [{ type: 'command', command: script('crash', 1, 'boom') }] },
        { hooks: [{ type: 'command', command: script('tests', 2, 'tests still fail') }] }
      ]
    })
    const hooks = await loadRunHooks(ws, 'run-2', null)
    expect(await hooks.postToolUse('edit', { path: 'a.ts' }, { ok: true, content: 'edited' })).toBe('lint: 2 errors')
    expect(await hooks.stop(false)).toBe('tests still fail')
    expect(logged().find((l) => l.hook_event_name === 'Stop')).toMatchObject({ stop_hook_active: false })
  }, 30_000)

  it('runs a workspace file only once the person allows that exact file', async () => {
    const path = join(ws, '.vyotiq', 'hooks.json')
    writeHooks(path, { PreToolUse: [{ hooks: [{ type: 'command', command: script('ws', 2, 'from the repo') }] }] })

    // Never asked (a helper instance): not run.
    expect(await (await loadRunHooks(ws, 'r', null)).preToolUse('read', {})).toBeNull()

    const ask = vi.fn(async (_commands: string[], _path: string) => 'deny' as const)
    expect(await (await loadRunHooks(ws, 'r', ask)).preToolUse('read', {})).toBeNull()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]![0]).toEqual([expect.stringContaining('PreToolUse: node')])
    // A decision sticks for the same file.
    await loadRunHooks(ws, 'r', ask)
    expect(ask).toHaveBeenCalledTimes(1)

    // A changed file asks again; allowed, it runs.
    writeHooks(path, { PreToolUse: [{ hooks: [{ type: 'command', command: script('ws2', 2, 'changed') }] }] })
    const allow = vi.fn(async (_commands: string[], _path: string) => 'allow' as const)
    expect(await (await loadRunHooks(ws, 'r', allow)).preToolUse('read', {})).toBe('changed')
    expect(allow).toHaveBeenCalledTimes(1)
  }, 30_000)

  it('ignores a file that is not a hooks file', () => {
    const bad = join(ws, 'bad.json')
    writeFileSync(bad, '{"hooks":{"OnSave":[]}}')
    expect(readHooksFile(bad, 'user')).toMatch(/not a hooks file/)
    writeFileSync(bad, '{nope')
    expect(readHooksFile(bad, 'user')).toMatch(/not valid JSON/)
    expect(readHooksFile(join(ws, 'missing.json'), 'user')).toBeNull()
  })
})
