import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  isFindstrNoMatch,
  isFindstrNoMatchContent,
  isDirMissingPath,
  isDirMissingPathContent,
  lastPipelineCommandToken,
  primaryCommandToken,
  POWERSHELL_EXIT_EPILOGUE,
  resolveTerminalShell,
  sanitizedTerminalEnv,
  terminalSpawnSpec,
  unixShellInvocation,
  unsupportedUnixOnWindowsMessage,
  bashForLoopOnPowerShellMessage,
  appendPowerShellCompatHint,
  nestedPowerShellCommandMessage,
  docxUnzipViaShellMessage,
  selfKillCommandMessage,
  appendMissingCommandHint,
  isMaskedExitCommand,
  parseEchoedExitCode
} from '@main/agent/tools/terminal'
import { executeTool } from '@main/agent/tools'
import { toolTerminal } from '@main/agent/tools/terminal'
import { getLoggerBackend, setLoggerBackend } from '@shared/logger'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('unixShellInvocation', () => {
  const prev = process.env.SHELL

  afterEach(() => {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
  })

  it('prefers $SHELL with -lc', () => {
    process.env.SHELL = '/usr/bin/zsh'
    expect(unixShellInvocation('echo hi')).toEqual({
      bin: '/usr/bin/zsh',
      args: ['-lc', 'echo hi']
    })
  })

  it('falls back to /bin/sh -c when SHELL is unset', () => {
    delete process.env.SHELL
    expect(unixShellInvocation('ls')).toEqual({
      bin: '/bin/sh',
      args: ['-c', 'ls']
    })
  })
})

describe('sanitizedTerminalEnv', () => {
  it('keeps PATH and drops planted secrets', () => {
    const env = sanitizedTerminalEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      OPENAI_API_KEY: 'sk-secret',
      ANTHROPIC_API_KEY: 'sk-ant',
      VYOTIQ_SECRET: 'nope'
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/dev')
    expect(env.APPDATA).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.VYOTIQ_SECRET).toBeUndefined()
  })

  it('keeps Windows gh/git config directories', () => {
    const env = sanitizedTerminalEnv({
      PATH: 'C:\\Windows\\system32',
      APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      GH_CONFIG_DIR: 'C:\\Users\\dev\\gh',
      XDG_CONFIG_HOME: 'C:\\Users\\dev\\.config',
      OPENAI_API_KEY: 'sk-secret'
    })
    expect(env.APPDATA).toBe('C:\\Users\\dev\\AppData\\Roaming')
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\dev\\AppData\\Local')
    expect(env.GH_CONFIG_DIR).toBe('C:\\Users\\dev\\gh')
    expect(env.XDG_CONFIG_HOME).toBe('C:\\Users\\dev\\.config')
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('keeps Windows ProgramData/ProgramFiles so NuGet can resolve machine folders', () => {
    const env = sanitizedTerminalEnv({
      PATH: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      ProgramData: 'C:\\ProgramData',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      CommonProgramFiles: 'C:\\Program Files\\Common Files',
      OPENAI_API_KEY: 'sk-secret'
    })
    expect(env.ProgramData).toBe('C:\\ProgramData')
    expect(env.ProgramFiles).toBe('C:\\Program Files')
    expect(env['ProgramFiles(x86)']).toBe('C:\\Program Files (x86)')
    expect(env.CommonProgramFiles).toBe('C:\\Program Files\\Common Files')
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  it('fills Windows folder defaults when SystemRoot is present but ProgramData was stripped', () => {
    const env = sanitizedTerminalEnv({
      PATH: 'C:\\Windows\\system32',
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'D:',
      OPENAI_API_KEY: 'sk-secret'
    })
    expect(env.ProgramData).toBe('D:\\ProgramData')
    expect(env.ProgramFiles).toBe('D:\\Program Files')
    expect(env.CommonProgramFiles).toBe('D:\\Program Files\\Common Files')
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('primaryCommandToken / lastPipelineCommandToken', () => {
  it('extracts the first argv token', () => {
    expect(primaryCommandToken('ls -la')).toBe('ls')
    expect(primaryCommandToken('  grep -r foo .')).toBe('grep')
    expect(primaryCommandToken('dir /s /b *.kt')).toBe('dir')
    expect(primaryCommandToken('findstr /i pattern')).toBe('findstr')
  })

  it('strips cmd /c prefix and path/extension', () => {
    expect(primaryCommandToken('cmd /c ls')).toBe('ls')
    expect(primaryCommandToken('C:\\Windows\\System32\\findstr.exe /i x')).toBe('findstr')
  })

  it('uses the first stage before && / |', () => {
    expect(primaryCommandToken('ls | findstr x')).toBe('ls')
    expect(primaryCommandToken('dir /s /b && echo done')).toBe('dir')
  })

  it('lastPipelineCommandToken reads the final pipe stage', () => {
    expect(lastPipelineCommandToken('dir /s /b | findstr /i foo')).toBe('findstr')
    expect(lastPipelineCommandToken('findstr /i foo')).toBe('findstr')
    expect(lastPipelineCommandToken('dir /s /b')).toBe('dir')
  })
})

describe('unsupportedUnixOnWindowsMessage', () => {
  it('hints for common Unix primaries', () => {
    for (const cmd of ['ls', 'grep foo', 'head -n 5 a.txt', 'find . -name x', 'cat a.txt', 'which node']) {
      const msg = unsupportedUnixOnWindowsMessage(cmd)
      expect(msg).toBeTruthy()
      expect(msg).toMatch(/cmd\.exe/)
      expect(msg).toMatch(/exit_code: 1/)
    }
  })

  it('steers file inspect commands to built-in tools', () => {
    const msg = unsupportedUnixOnWindowsMessage('grep foo')
    expect(msg).toMatch(/grep tool/)
    expect(msg).toMatch(/grep, read, glob, and list_dir tools/)
    const catMsg = unsupportedUnixOnWindowsMessage('cat a.txt')
    expect(catMsg).toMatch(/read tool/)
    expect(catMsg).toMatch(/grep, read, glob, and list_dir tools/)
  })

  it('does not flag cmd-safe commands', () => {
    expect(unsupportedUnixOnWindowsMessage('dir /s /b')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('findstr /i foo')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('where node')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('type readme.md')).toBeNull()
    expect(unsupportedUnixOnWindowsMessage('echo hi')).toBeNull()
  })

  it('blocks Unix tools in later pipeline stages before spawn', () => {
    const msg = unsupportedUnixOnWindowsMessage('dir /s /b | grep foo')
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/grep/)
    expect(msg).toMatch(/cmd\.exe/)
  })
})

describe('isFindstrNoMatch', () => {
  it('treats exit 1 + empty stdout as no-match soft success', () => {
    expect(isFindstrNoMatch('findstr /i missing', 1, '', '')).toBe(true)
    expect(isFindstrNoMatch('dir /s /b | findstr /i missing', 1, '  \n', '')).toBe(true)
  })

  it('does not soft-succeed on exit 0, exit 2, or non-findstr', () => {
    expect(isFindstrNoMatch('findstr /i x', 0, 'hit\n', '')).toBe(false)
    expect(isFindstrNoMatch('findstr /i x', 2, '', 'error')).toBe(false)
    expect(isFindstrNoMatch('dir /s /b', 1, '', '')).toBe(false)
  })

  it('rejects catastrophic stderr', () => {
    expect(
      isFindstrNoMatch('findstr /i x', 1, '', `'findstr' is not recognized as an internal or external command`)
    ).toBe(false)
    expect(isFindstrNoMatch('findstr /i x', 1, '', 'The system cannot find the path specified.')).toBe(
      false
    )
  })

  it('rejects non-empty stdout with exit 1', () => {
    expect(isFindstrNoMatch('findstr /i x', 1, 'unexpected\n', '')).toBe(false)
  })

  it('parses tool content via isFindstrNoMatchContent', () => {
    expect(
      isFindstrNoMatchContent(
        'dir /s /b | findstr /i zzznomatch',
        'findstr: no matches\nexit_code: 1'
      )
    ).toBe(true)
    expect(
      isFindstrNoMatchContent('findstr /i x', 'stderr:\n\'findstr\' is not recognized\nexit_code: 1')
    ).toBe(false)
    expect(isFindstrNoMatchContent('dir', 'exit_code: 1')).toBe(false)
  })
})

describe('isDirMissingPath', () => {
  it('treats dir missing target as soft success on win32', () => {
    if (process.platform !== 'win32') return
    expect(
      isDirMissingPath(
        'dir /b "missing-folder"',
        1,
        '',
        'The system cannot find the file specified.'
      )
    ).toBe(true)
    expect(isDirMissingPath('dir /b', 1, '', '')).toBe(false)
  })

  it('parses tool content via isDirMissingPathContent', () => {
    if (process.platform !== 'win32') return
    expect(
      isDirMissingPathContent(
        'dir /b "nope"',
        'cwd: C:\\ws\n\ndir: path not found\nstderr:\nFile Not Found\nexit_code: 1'
      )
    ).toBe(true)
  })
})

describe('resolveTerminalShell / terminalSpawnSpec', () => {
  it('maps preferences to resolved shells', () => {
    expect(resolveTerminalShell('cmd', 'win32')).toBe('cmd')
    expect(resolveTerminalShell('cmd', 'linux')).toBe('unix')
    expect(resolveTerminalShell('powershell', 'win32')).toBe('powershell')
    expect(resolveTerminalShell('bash', 'darwin')).toBe('bash')
    expect(resolveTerminalShell('auto', 'linux')).toBe('unix')
  })

  it('builds spawn args for each resolved shell', () => {
    expect(terminalSpawnSpec('echo hi', 'cmd')).toEqual({
      resolved: 'cmd',
      bin: 'cmd.exe',
      args: ['/c', 'echo hi']
    })
    expect(terminalSpawnSpec('Get-ChildItem', 'powershell').args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-ChildItem\n; ${POWERSHELL_EXIT_EPILOGUE}`
    ])
    expect(terminalSpawnSpec('ls', 'bash')).toEqual({
      resolved: 'bash',
      bin: 'bash',
      args: ['-lc', 'ls']
    })
  })
})

describe('Windows terminal executeTool behavior', () => {
  it('spawns Unix primaries on win32 instead of pre-failing', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-unix-'))
    const signal = new AbortController().signal
    const content = await toolTerminal(dir, 'ls -la', signal, { shell: 'cmd' })
    expect(content).not.toMatch(/Unsupported Unix command/)
    expect(content).toMatch(/exit_code:/)
  })

  it('spawns bash for-loops on PowerShell instead of pre-failing', async () => {
    const cmd =
      'node --version 2>&1; for f in js/setup.js js/audio.js js/input.js js/particles.js js/entities.js js/flow.js js/game.js; do node --check "$f" && echo "OK $f"; done'
    expect(bashForLoopOnPowerShellMessage(cmd)).toMatch(/bash for-loop/i)
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-bashfor-'))
    const signal = new AbortController().signal
    const content = await toolTerminal(dir, cmd, signal, { shell: 'powershell' })
    expect(content).not.toMatch(/bash for-loop/i)
    expect(content).toMatch(/exit_code:/)
  })

  it('treats findstr no-match as soft success on win32 with cmd', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-findstr-'))
    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8')
    const signal = new AbortController().signal
    const content = await toolTerminal(dir, 'findstr /i zzznomatch123 a.txt', signal, {
      shell: 'cmd'
    })
    expect(content).toMatch(/findstr: no matches/)
    expect(content).toMatch(/shell: cmd/)
    expect(content).toMatch(/exit_code: 1/)
  })
})

describe('appendPowerShellCompatHint', () => {
  it('hints npm execution policy failures', () => {
    const base = 'cwd: /ws\nshell: powershell\nstderr:\nnpm.ps1 cannot be loaded\nexit_code: 1'
    const out = appendPowerShellCompatHint(base, 1, 'npm.ps1 cannot be loaded', 'powershell')
    expect(out).toContain('npm.cmd')
    expect(out).toContain('execution policy')
  })

  it('hints invalid && chaining in PowerShell 5', () => {
    const stderr = "The token '&&' is not a valid statement separator in this version."
    const base = `cwd: /ws\nshell: powershell\nstderr:\n${stderr}\nexit_code: 1`
    const out = appendPowerShellCompatHint(base, 1, stderr, 'powershell')
    expect(out).toContain('&& is not valid')
  })

  it('skips hints on success', () => {
    const base = 'cwd: /ws\nshell: powershell\nexit_code: 0'
    expect(appendPowerShellCompatHint(base, 0, '', 'powershell')).toBe(base)
  })

  it('hints PowerShell parse errors from nested -Command quoting', () => {
    const stderr = "The string is missing the terminator: \".\r\n    + CategoryInfo          : ParserError"
    const base = `cwd: /ws\nshell: powershell\nstderr:\n${stderr}\nexit_code: 1`
    const out = appendPowerShellCompatHint(base, 1, stderr, 'powershell')
    expect(out).toMatch(/already PowerShell/i)
    expect(out).toMatch(/powershell -Command/)
  })

  it('hints space-before-dot member access and -split on a path (75135925)', () => {
    const stderr = "Unexpected token '.Line' in expression or statement."
    const command =
      '$log = "$env:TEMP\\vyotiq-vitest-full.log"\n($log -split "`n" | ForEach-Object { ($_ .Line -replace "FAIL","").Trim() })'
    const base = `cwd: /ws\nshell: powershell\nstderr:\n${stderr}\nexit_code: 1`
    const out = appendPowerShellCompatHint(base, 1, stderr, 'powershell', command)
    expect(out).toMatch(/\$_\.Line not \$_ \.Line/)
    expect(out).toMatch(/Get-Content/)
    expect(out).toMatch(/do not -split the path string/i)
  })
})

describe('appendMissingCommandHint', () => {
  it('hints PowerShell cmdlet-not-found without retrying PATH', () => {
    const stderr =
      "swift : The term 'swift' is not recognized as the name of a cmdlet, function, script file, or operable program."
    const base = `cwd: /ws\nshell: powershell\nstderr:\n${stderr}\nexit_code: 1`
    const out = appendMissingCommandHint(base, 1, stderr)
    expect(out).toMatch(/not on PATH/)
    expect(out).toMatch(/Do not retry the same invocation/)
  })

  it('does not treat The term = parse error as a missing binary', () => {
    const stderr = "The term '=' is not recognized as the name of a cmdlet"
    const base = `cwd: /ws\nshell: powershell\nstderr:\n${stderr}\nexit_code: 1`
    expect(appendMissingCommandHint(base, 1, stderr)).toBe(base)
  })

  it('hints cmd.exe not-recognized', () => {
    const stderr = "'dotnet' is not recognized as an internal or external command"
    const base = `cwd: /ws\nshell: cmd\nstderr:\n${stderr}\nexit_code: 1`
    expect(appendMissingCommandHint(base, 1, stderr)).toMatch(/not on PATH/)
  })
})

describe('nestedPowerShellCommandMessage', () => {
  it('pre-fails powershell -Command when the session is already PowerShell', () => {
    const cmd =
      'powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead(\'docs/a.md.docx\')"'
    const msg = nestedPowerShellCommandMessage(cmd, 'powershell')
    expect(msg).toMatch(/already PowerShell/i)
    expect(msg).toMatch(/Pass the PowerShell statements/i)
    expect(nestedPowerShellCommandMessage(cmd, 'cmd')).toBeNull()
    expect(nestedPowerShellCommandMessage('Get-ChildItem src', 'powershell')).toBeNull()
    expect(nestedPowerShellCommandMessage('powershell -File scripts/ext.ps1', 'powershell')).toBeNull()
  })

  it('pre-fails via toolTerminal without spawning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-nested-ps-'))
    const signal = new AbortController().signal
    const content = await toolTerminal(
      dir,
      'powershell -NoProfile -Command "Write-Host $PWD"',
      signal,
      { shell: 'powershell' }
    )
    expect(content).toMatch(/already PowerShell/i)
    expect(content).toMatch(/shell: powershell/)
    expect(content).toMatch(/exit_code: 1/)
  })
})

describe('docxUnzipViaShellMessage', () => {
  const unzip =
    'powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [IO.Compression.ZipFile]::OpenRead(\'docs/a.md.docx\')"'

  it('pre-fails the AGENTS.md ZipFile unzip recipe before spawn', () => {
    const msg = docxUnzipViaShellMessage(unzip)
    expect(msg).toMatch(/Do not unzip Word \.docx/i)
    expect(msg).toMatch(/Call read on the \.docx path/i)
    expect(docxUnzipViaShellMessage('Get-ChildItem docs/a.md.docx')).toBeNull()
    expect(docxUnzipViaShellMessage('Add-Type -AssemblyName System.IO.Compression.FileSystem')).toBeNull()
  })

  it('pre-fails via toolTerminal without spawning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-term-docx-unzip-'))
    const signal = new AbortController().signal
    const content = await toolTerminal(dir, unzip, signal, { shell: 'powershell' })
    expect(content).toMatch(/Do not unzip Word \.docx/i)
    expect(content).toMatch(/Call read on the \.docx path/i)
    expect(content).toMatch(/shell: powershell/)
    expect(content).toMatch(/exit_code: 1/)
  })
})

describe('tool success logging', () => {
  const prev = getLoggerBackend()
  const info = vi.fn()

  afterEach(() => {
    setLoggerBackend(prev)
    info.mockReset()
  })

  it('logs one info line on successful tool execution', async () => {
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'info') info({ message, fields })
      }
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-ok-log-'))
    writeFileSync(join(dir, 'r.txt'), 'payload', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'read',
      JSON.stringify({ path: 'r.txt' }),
      dir,
      signal
    )
    expect(result.ok).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0].message).toBe('Tool succeeded')
    expect(info.mock.calls[0][0].fields).toMatchObject({
      scope: 'tools',
      tool: 'read'
    })
  })
})

describe('exit-code masking', () => {
  it('detects a command whose trailing statement is a string literal', () => {
    // `…; "shard-B exit: $LASTEXITCODE"` always leaves the shell at 0.
    expect(
      isMaskedExitCommand('pnpm exec vitest run 2>&1 | Select-Object -Last 8; "shard-B exit: $LASTEXITCODE"')
    ).toBe(true)
    expect(isMaskedExitCommand("pytest -q; 'done'")).toBe(true)
  })

  it('does not flag commands that end with a real statement', () => {
    expect(isMaskedExitCommand('pnpm exec vitest run')).toBe(false)
    expect(isMaskedExitCommand('pnpm test; exit $LASTEXITCODE')).toBe(false)
    expect(isMaskedExitCommand('')).toBe(false)
  })

  it('recovers the real code from a self-reported footer line', () => {
    expect(parseEchoedExitCode('Tests  1 failed | 2342 passed\nshard-B exit: 1')).toBe(1)
    expect(parseEchoedExitCode('all good\nexit: 0')).toBe(0)
  })

  it('returns null when no exit code is stated', () => {
    expect(parseEchoedExitCode('Tests  1 failed | 2342 passed')).toBeNull()
    expect(parseEchoedExitCode('')).toBeNull()
  })

  it('warns on a masked command even though the shell reported 0', () => {
    const base = 'cwd: /ws\nshell: powershell\nTests  1 failed\nshard-B exit: 1\nexit_code: 0'
    const out = appendPowerShellCompatHint(
      base,
      0,
      '',
      'powershell',
      'pnpm test 2>&1 | Select-Object -Last 8; "shard-B exit: $LASTEXITCODE"'
    )
    // A masked failure is still a failure — it must not be dropped just
    // because the shell's own exit code was 0.
    expect(out).toMatch(/Exit code masked/)
  })

  it('reports the echoed exit code for a masked command instead of the shell 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-masked-exit-'))
    const result = await toolTerminal(
      dir,
      'echo "shard-A exit: 1"; "shard-A exit: 1"',
      new AbortController().signal,
      { timeoutMs: 30_000, shell: 'powershell' }
    )
    expect(result).toMatch(/exit_code: 1/)
    expect(result).toMatch(/Exit code masked/)
  })
})

describe('PowerShell native-stderr exit inflation (win32)', () => {
  // Root cause measured on this machine (2026-08-31): inside `… 2>&1`, PS 5.1
  // turns every native stderr line into a NativeCommandError record and the
  // outer powershell.exe exits 1 even when the native command exited 0 —
  // `ssh -V 2>&1` reported a successful version check as a failure.
  it('reports success when only benign native stderr was redirected', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nce-ok-'))
    const result = await toolTerminal(
      dir,
      'ssh -V 2>&1 | Select-Object -Last 1',
      new AbortController().signal,
      { timeoutMs: 30_000, shell: 'powershell' }
    )
    expect(result).toMatch(/exit_code: 0/)
  })

  it('still fails a command whose native child genuinely failed', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nce-fail-'))
    const result = await toolTerminal(
      dir,
      'cmd /c exit 3 2>&1 | Select-Object -Last 1',
      new AbortController().signal,
      { timeoutMs: 30_000, shell: 'powershell' }
    )
    expect(result).toMatch(/exit_code: 3/)
  })

  it('still fails a real cmdlet failure redirected through 2>&1', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nce-cmdlet-'))
    const result = await toolTerminal(
      dir,
      'Get-Item .definitely-missing-xyz 2>&1 | Select-Object -Last 2',
      new AbortController().signal,
      { timeoutMs: 30_000, shell: 'powershell' }
    )
    expect(result).toMatch(/exit_code: 1/)
  })

  it('preserves a deliberate trailing exit statement', async () => {
    if (process.platform !== 'win32') return
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nce-exit-'))
    const result = await toolTerminal(
      dir,
      "Write-Output hi\nexit 5",
      new AbortController().signal,
      { timeoutMs: 30_000, shell: 'powershell' }
    )
    expect(result).toMatch(/exit_code: 5/)
  })
})

describe('selfKillCommandMessage', () => {
  const host = ['electron', 'vyotiq']

  it('refuses the observed self-kill sweep', () => {
    const msg = selfKillCommandMessage(
      'Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue',
      host
    )
    expect(msg).toMatch(/Refused/)
    expect(msg).toMatch(/verified orphan PIDs/i)
  })

  it('refuses name-based taskkill of the host image', () => {
    expect(selfKillCommandMessage('taskkill /F /IM electron.exe', host)).toMatch(/Refused/)
    expect(selfKillCommandMessage('Stop-Process -Name Electron', host)).toMatch(/Refused/)
    expect(selfKillCommandMessage('kill -Name electron', host)).toMatch(/Refused/)
  })

  it('does not match electron-prefixed tools like electron-builder', () => {
    expect(
      selfKillCommandMessage(
        'pnpm exec electron-builder --win dir --publish never',
        host
      )
    ).toBeNull()
    expect(selfKillCommandMessage('pnpm build && pnpm exec electron-vite preview', host)).toBeNull()
  })

  it('allows PID-targeted kills and unrelated process names', () => {
    expect(selfKillCommandMessage('Stop-Process -Id 4242 -Force', host)).toBeNull()
    expect(selfKillCommandMessage('taskkill /F /PID 4242 /T', host)).toBeNull()
    expect(selfKillCommandMessage('Get-Process node | Stop-Process -Force', host)).toBeNull()
  })
})
