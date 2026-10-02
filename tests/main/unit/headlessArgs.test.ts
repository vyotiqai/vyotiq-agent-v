import { describe, expect, it } from 'vitest'
import { isHeadlessArgv, parseHeadlessArgs, splitModelArg } from '@main/headless/args'

const base = ['C:\\electron.exe', '.']

function parse(...rest: string[]) {
  return parseHeadlessArgs([...base, '--headless', ...rest])
}

function options(...rest: string[]) {
  const parsed = parse(...rest)
  if (!parsed.ok || 'help' in parsed) throw new Error(`expected options, got ${JSON.stringify(parsed)}`)
  return parsed.options
}

describe('isHeadlessArgv', () => {
  it('finds the flag wherever the launcher put it', () => {
    expect(isHeadlessArgv(['Vyotiq.exe', '--headless'])).toBe(true)
    expect(isHeadlessArgv(['electron', '.', '--inspect', '--headless', '-p', 'x'])).toBe(true)
    expect(isHeadlessArgv(['Vyotiq.exe', 'vyotiq://open'])).toBe(false)
  })
})

describe('parseHeadlessArgs', () => {
  it('defaults to a denying, text-output agent run on stdin', () => {
    expect(options()).toEqual({
      prompt: { kind: 'auto' },
      mode: 'agent',
      approval: 'deny',
      onQuestion: 'answer',
      doneWhen: [],
      output: 'text',
      worktree: false,
      quiet: false
    })
  })

  it('reads every flag in both spellings', () => {
    const o = options(
      '--cwd',
      'C:\\repo',
      '--prompt=fix the bug',
      '--mode',
      'ask',
      '--model=anthropic/claude-sonnet-4-5',
      '--approval',
      'allow-safe',
      '--on-question=fail',
      '--done-when',
      'tests pass',
      '--done-when=lint is clean',
      '--max-steps',
      '12',
      '--max-cost=0.5',
      '--timeout',
      '90',
      '--output',
      'stream-json',
      '--output-file',
      'out.json',
      '--worktree',
      '-q'
    )
    expect(o).toEqual({
      cwd: 'C:\\repo',
      prompt: { kind: 'text', text: 'fix the bug' },
      mode: 'ask',
      model: 'anthropic/claude-sonnet-4-5',
      approval: 'allow-safe',
      onQuestion: 'fail',
      doneWhen: ['tests pass', 'lint is clean'],
      maxSteps: 12,
      maxCostUsd: 0.5,
      timeoutSec: 90,
      output: 'stream-json',
      outputFile: 'out.json',
      worktree: true,
      quiet: true
    })
  })

  it('ignores what comes before --headless (launcher path, Chromium switches)', () => {
    const parsed = parseHeadlessArgs(['electron', '.', '--enable-logging', '--headless', '-p', 'hi'])
    expect(parsed).toMatchObject({ ok: true, options: { prompt: { kind: 'text', text: 'hi' } } })
  })

  it('steps over Electron switches after --headless too', () => {
    const parsed = parseHeadlessArgs(['electron', '.', '--headless', '--user-data-dir=C:\\p', '-p', 'hi', '--enable-logging'])
    expect(parsed).toMatchObject({ ok: true, options: { prompt: { kind: 'text', text: 'hi' } } })
  })

  it('takes the prompt from a file or stdin', () => {
    expect(options('--prompt-file', 'task.md').prompt).toEqual({ kind: 'file', path: 'task.md' })
    expect(options('-p', '-').prompt).toEqual({ kind: 'stdin' })
  })

  it('folds plan into agent, as the app does', () => {
    expect(options('--mode', 'plan').mode).toBe('agent')
  })

  it('answers --help', () => {
    expect(parse('--help')).toEqual({ ok: true, help: true })
    expect(parse('-p', 'x', '-h')).toEqual({ ok: true, help: true })
  })

  it.each([
    [['--max-cost', '5', '--bogus'], /Unknown option --bogus/],
    [['fix', 'it'], /Unexpected argument "fix"/],
    [['--prompt', 'a', '--prompt-file', 'b'], /Give the prompt once/],
    [['--prompt'], /--prompt needs a value/],
    [['--prompt', '--mode', 'ask'], /--prompt needs a value/],
    [['--prompt', '   '], /--prompt is empty/],
    [['--mode', 'yolo'], /--mode must be one of agent, ask/],
    [['--approval', 'yes'], /--approval must be one of deny, allow-safe, allow-all/],
    [['--on-question', 'maybe'], /--on-question must be one of/],
    [['--output', 'xml'], /--output must be one of text, json, stream-json/],
    [['--max-steps', '2.5'], /--max-steps needs a positive whole number/],
    [['--max-steps', '0'], /--max-steps needs a positive whole number/],
    [['--max-cost', 'lots'], /--max-cost needs a positive number/],
    [['--timeout', '-1'], /--timeout needs a value|--timeout needs a positive number/],
    [['--worktree=yes'], /--worktree takes no value/],
    [['--model', 'openai/'], /--model needs a model id/],
    [['--done-when', ''], /--done-when is empty/]
  ])('refuses %j', (args, message) => {
    const parsed = parse(...args)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(message)
  })
})

describe('splitModelArg', () => {
  const known = (id: string): boolean => ['anthropic', 'openrouter'].includes(id) || id.startsWith('custom:')

  it('splits off a known provider', () => {
    expect(splitModelArg('anthropic/claude-x', known)).toEqual({ provider: 'anthropic', model: 'claude-x' })
    expect(splitModelArg('openrouter/meta/llama-3', known)).toEqual({ provider: 'openrouter', model: 'meta/llama-3' })
    expect(splitModelArg('custom:my-box/qwen', known)).toEqual({ provider: 'custom:my-box', model: 'qwen' })
  })

  it('leaves anything else as a model on the configured provider', () => {
    expect(splitModelArg('gpt-5', known)).toEqual({ model: 'gpt-5' })
    expect(splitModelArg('meta-llama/llama-3', known)).toEqual({ model: 'meta-llama/llama-3' })
  })
})
