import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-hooks-ud-'))
vi.mock('electron', () => ({ app: { getPath: (n: string) => (n === 'userData' ? userData : tmpdir()) } }))

import {
  hookCommands,
  loadRunHooks,
  parseHooksFile,
  readHooksFile,
  resetHooksForTests,
  runHookCommand
} from '@main/agent/hooks'
import { logger } from '@shared/logger'

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
    writeFileSync(bad, '{"permissions":{}}')
    expect(readHooksFile(bad, 'user')).toMatch(/not a hooks file/)
    writeFileSync(bad, '{"hooks":[]}')
    expect(readHooksFile(bad, 'user')).toMatch(/not a hooks file/)
    writeFileSync(bad, '{nope')
    expect(readHooksFile(bad, 'user')).toMatch(/not valid JSON/)
    expect(readHooksFile(join(ws, 'missing.json'), 'user')).toBeNull()
  })

  it("reads a Claude Code settings.json: keeps the command hooks it runs, skips the rest", () => {
    // The shape `.claude/settings.json` takes, other keys and all.
    const settings = {
      permissions: { allow: ['Bash(npm test:*)'] },
      env: { FOO: '1' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh', timeout: 30 },
              { type: 'prompt', prompt: 'Is this command safe?' }
            ]
          },
          { matcher: 'Write', hooks: [{ type: 'prompt', prompt: 'only prompts here' }] }
        ],
        PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx prettier --check .', timeout: 900 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/prompt.js' }] }],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'git status --short' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo compacting' }] }],
        Stop: 'not even a list'
      }
    }
    const parsed = parseHooksFile(settings)
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.file.hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh', timeout: 30 }] }],
      PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx prettier --check .', timeout: 900 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/prompt.js' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'git status --short' }] }]
    })
    expect(parsed.skipped).toEqual([
      'PreToolUse[0].hooks[1] (a "prompt" hook)',
      'PreToolUse[1].hooks[0] (a "prompt" hook)',
      'SubagentStop (not an event Agent V runs)',
      'PreCompact (not an event Agent V runs)',
      'Stop (not a list)'
    ])

    // From disk: the same file loads, and the trust prompt lists the new events.
    const path = join(ws, 'settings.json')
    writeFileSync(path, JSON.stringify(settings))
    const loaded = readHooksFile(path, 'workspace')
    if (loaded === null || typeof loaded === 'string') throw new Error(String(loaded))
    expect(hookCommands(loaded.file)).toEqual([
      'PreToolUse (Bash): "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
      'PostToolUse (Edit|Write): npx prettier --check .',
      'UserPromptSubmit: node .claude/hooks/prompt.js',
      'SessionStart (startup): git status --short'
    ])
  })

  it('logs skipped entries once per file version', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const path = join(ws, 'h.json')
    writeFileSync(path, JSON.stringify({ hooks: { SubagentStop: [] } }))
    readHooksFile(path, 'user')
    readHooksFile(path, 'user')
    expect(warn.mock.calls.filter(([m]) => m === 'Hooks file entries skipped')).toHaveLength(1)
    warn.mockRestore()
  })

  it("reads Claude Code's JSON decisions on stdout", async () => {
    const json = (name: string, out: unknown): string => {
      const file = join(scripts, `${name}.cjs`)
      writeFileSync(file, `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(out))}))`)
      return `node "${file}"`
    }
    writeHooks(join(userData, 'hooks.json'), {
      PreToolUse: [
        { matcher: 'terminal', hooks: [{ type: 'command', command: json('deny', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no rm -rf' } }) }] },
        { matcher: 'edit', hooks: [{ type: 'command', command: json('block', { decision: 'block', reason: 'generated file' }) }] },
        { matcher: 'read', hooks: [{ type: 'command', command: json('allow', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }) }] }
      ],
      Stop: [{ hooks: [{ type: 'command', command: json('stop', { decision: 'block', reason: 'tests are red' }) }] }]
    })
    const hooks = await loadRunHooks(ws, 'run-json', null)
    expect(await hooks.preToolUse('terminal', { command: 'rm -rf /' })).toBe('no rm -rf')
    expect(await hooks.preToolUse('edit', { path: 'gen.ts' })).toBe('generated file')
    expect(await hooks.preToolUse('read', { path: 'a' })).toBeNull()
    expect(await hooks.stop(false)).toBe('tests are red')
  }, 30_000)

  it('UserPromptSubmit blocks on exit 2 or a JSON block, and passes context; SessionStart matches its source', async () => {
    writeHooks(join(userData, 'hooks.json'), {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: script('prompt', 0) }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: 'node -e "process.stdout.write(\'resumed context\')"' }] }]
    })
    const hooks = await loadRunHooks(ws, 'run-p', null)
    expect(await hooks.userPromptSubmit('hello')).toEqual({ blocked: null, context: null })
    expect(logged()).toEqual([{ session_id: 'run-p', cwd: ws, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }])
    expect(await hooks.sessionStart('startup')).toBeNull()
    expect(await hooks.sessionStart('resume')).toBe('resumed context')

    writeHooks(join(userData, 'hooks.json'), {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: script('deny', 2, 'contains a key') }] },
        { hooks: [{ type: 'command', command: script('never', 0) }] }
      ]
    })
    const blocking = await loadRunHooks(ws, 'run-p2', null)
    expect(await blocking.userPromptSubmit('key=sk-1')).toEqual({ blocked: 'contains a key', context: null })
    // A block ends the event: the second hook never ran.
    expect(logged().filter((l) => l.session_id === 'run-p2')).toHaveLength(1)
  }, 30_000)

  it('cuts a timeout over 600 seconds to 600 instead of rejecting the file', async () => {
    writeHooks(join(userData, 'hooks.json'), { Stop: [{ hooks: [{ type: 'command', command: script('slow', 0), timeout: 3600 }] }] })
    const loaded = readHooksFile(join(userData, 'hooks.json'), 'user')
    if (loaded === null || typeof loaded === 'string') throw new Error(String(loaded))
    expect(loaded.file.hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(3600)
    expect(await (await loadRunHooks(ws, 'run-t', null)).stop(false)).toBeNull()
  }, 30_000)
})
