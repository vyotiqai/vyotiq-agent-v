import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  decodeConsoleText,
  isCommandProbeNoTarget,
  isCommandProbeNoTargetContent,
  isElevationDenied,
  isElevationDeniedContent,
  isProcessKillSweep,
  isProcessKillSweepContent,
  isRemoteGrepNoMatch,
  isRemoteGrepNoMatchContent,
  formatTerminalSessionOutput
} from '@main/agent/tools/terminal'
import { terminalResultOk } from '@main/agent/tools'

/**
 * Fixtures are the verbatim outcomes from run 1de9344a (Aether OS build,
 * 2026-08-30): four consecutive terminal "failures" — three informative
 * answers plus one declined UAC prompt — stopped the run via LOOP_SAFETY.
 */

const utf16Stderr = (text: string): Buffer => {
  const le = Buffer.from(text, 'utf16le')
  return Buffer.concat([Buffer.from([0xff, 0xfe]), le])
}

describe('decodeConsoleText', () => {
  it('decodes UTF-16LE stderr (wsl.exe redirected output) into readable text', () => {
    const buf = utf16Stderr('The Windows Subsystem for Linux is not installed.')
    const text = decodeConsoleText(buf)
    expect(text).toBe('The Windows Subsystem for Linux is not installed.')
    expect(text).not.toContain('\u0000')
  })

  it('decodes BOM-less UTF-16LE', () => {
    expect(decodeConsoleText(Buffer.from('wsl: not installed', 'utf16le'))).toBe(
      'wsl: not installed'
    )
  })

  it('keeps plain UTF-8 untouched', () => {
    const buf = Buffer.from('podman : The term is not recognized\nsecond line', 'utf8')
    expect(decodeConsoleText(buf)).toBe('podman : The term is not recognized\nsecond line')
  })

  it('strips stray NULs from printable output — byte-identical minus the NULs', () => {
    // A NUL is never part of a multi-byte UTF-8 sequence, so stripping is safe
    // for any NUL-bearing printable chunk regardless of the two-NUL signature.
    const buf = Buffer.concat([Buffer.from([0x00, 0x41]), Buffer.from('plain', 'utf8')])
    expect(decodeConsoleText(buf)).toBe('Aplain')
  })

  it('keeps non-printable binary noise on the original UTF-8 decode (never worse)', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03, 0x07, 0x00, 0x1f, 0x0b, 0x00])
    expect(decodeConsoleText(buf)).toBe(buf.toString('utf8'))
  })

  it('repairs a MIXED stream: ASCII prefix + UTF-16LE body (real wsl.exe capture shape)', () => {
    // Verbatim shape from the 2026-08-30 raw byte capture of `wsl --status 2>&1`
    // stderr: 77 73 6c 20 3a 20 ("wsl : ") then UTF-16LE payload.
    const buf = Buffer.concat([
      Buffer.from('wsl : ', 'utf8'),
      Buffer.from('The Windows Subsystem for Linux is not installed.', 'utf16le')
    ])
    const text = decodeConsoleText(buf)
    expect(text).toBe('wsl : The Windows Subsystem for Linux is not installed.')
    expect(text).not.toContain('\u0000')
  })

  it('leaves BOM-less NUL-free UTF-16 (CJK-only) untouched — byte-ambiguous with UTF-8', () => {
    // No BOM, no NUL signature: re-decoding would corrupt genuine UTF-8 CJK
    // output (real git-log CJK paths), so this deliberately stays UTF-8.
    const buf = Buffer.from('日本語テスト', 'utf16le')
    expect(decodeConsoleText(buf)).toBe(buf.toString('utf8'))
  })
})

describe('isCommandProbeNoTarget', () => {
  it('classifies a --version probe hitting a missing command as informative', () => {
    const stderr = `podman : The term 'podman' is not recognized as the name of a cmdlet, function, script file, or operable program.`
    expect(
      isCommandProbeNoTarget('podman --version 2>&1; docker --version 2>&1', 1, '', stderr)
    ).toBe(true)
  })

  it('classifies a --status probe answered with "is not installed"', () => {
    expect(
      isCommandProbeNoTarget('wsl --status 2>&1; wsl -l -v 2>&1', 1, '', 'wsl: not installed')
    ).toBe(false)
    expect(
      isCommandProbeNoTarget('wsl --status 2>&1', 50, '', 'WSL is not installed on this machine.')
    ).toBe(true)
  })

  it('never treats a PowerShell parse error as a probe answer', () => {
    const stderr = "The term '=' is not recognized as the name of a cmdlet"
    expect(isCommandProbeNoTarget('podman --version 2>&1', 1, '', stderr)).toBe(false)
  })

  it('ignores non-zero exits from non-probe commands', () => {
    expect(isCommandProbeNoTarget('cargo test --release', 101, '', 'error: could not compile')).toBe(
      false
    )
    expect(isCommandProbeNoTarget('pnpm run lint', 1, '', 'oops')).toBe(false)
  })

  it('ignores zero and null exit codes', () => {
    expect(isCommandProbeNoTarget('podman --version', 0, 'podman version 4.0', '')).toBe(false)
    expect(isCommandProbeNoTarget('podman --version', null, '', '')).toBe(false)
  })

  it('classifies real probe content through the terminal frame (content parser)', () => {
    const content = [
      'cwd: C:\\machine\\ws',
      'shell: powershell',
      '',
      '',
      "stderr:\npodman : The term 'podman' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'exit_code: 1'
    ].join('\n')
    expect(isCommandProbeNoTargetContent('podman --version 2>&1', content)).toBe(true)
    expect(terminalResultOk('podman --version 2>&1', content)).toBe(true)
  })

  it('classifies through a session-poll frame using the header command', () => {
    const content = formatTerminalSessionOutput({
      cwd: 'C:\\ws',
      command: 'podman --version 2>&1',
      shell: 'powershell',
      stdout: '',
      stderr:
        "podman : The term 'podman' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      exitCode: 1,
      sessionId: 'sess-1',
      status: 'done'
    })
    expect(isCommandProbeNoTargetContent('session', content)).toBe(true)
    expect(terminalResultOk('session', content)).toBe(true)
  })
})

describe('isElevationDenied', () => {
  it('classifies the winget administrator-privileges denial', () => {
    expect(
      isElevationDenied(
        'winget install --id Microsoft.WSL --silent',
        1,
        'Installer failed with exit code: 0x80073d28 : The package installation failed because administrator privileges are required.',
        ''
      )
    ).toBe(true)
  })

  it('classifies a declined UAC prompt (Start-Process -Verb RunAs)', () => {
    expect(
      isElevationDenied(
        'Start-Process powershell -Verb RunAs -Wait',
        1,
        '',
        'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.'
      )
    ).toBe(true)
  })

  it('matches on the raw hex code alone', () => {
    expect(isElevationDenied('winget install X', -2147009240, 'exit=0x80073d28', '')).toBe(true)
  })

  it('does not swallow generic access denied or real failures', () => {
    expect(isElevationDenied('git push origin main', 128, '', 'remote: Access denied')).toBe(false)
    expect(isElevationDenied('cargo test --release', 101, 'error: could not compile', '')).toBe(
      false
    )
  })

  it('classifies through the terminal frame and via terminalResultOk', () => {
    const content = [
      'cwd: C:\\ws',
      'shell: powershell',
      '',
      "stderr:\nStart-Process : This command cannot be run due to the error: The operation was canceled by the user.",
      'exit_code: 1'
    ].join('\n')
    expect(isElevationDeniedContent('Start-Process -Verb RunAs', content)).toBe(true)
    expect(terminalResultOk('Start-Process -Verb RunAs', content)).toBe(true)
  })
})

describe('isRemoteGrepNoMatch', () => {
  // Fixtures verbatim from run 1de9344a invoke 2 (steps 119-122): ssh-polling
  // an Alpine VM for a pattern that had not appeared yet — grep exit 1, empty
  // streams. The loop stopped after 4 such "failures" in a row.
  const sshGrepNoMatch =
    "ssh -i .vmkey\\id_ed25519 -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ConnectTimeout=30 root@127.0.0.1 'n1=$(grep -c PASS_DESKTOP /var/log/console.log 2>/dev/null); echo n1='$n1"

  it('classifies ssh-wrapped grep exit 1 with empty streams as informative', () => {
    expect(isRemoteGrepNoMatch(sshGrepNoMatch, 1, '', '')).toBe(true)
  })

  it('classifies through the terminal frame and terminalResultOk', () => {
    const content = [
      `session_id: a2971168-bc95-4f30-9a93-1866afd502c2`,
      'status: done',
      `command: ${sshGrepNoMatch} 2>&1`,
      'cwd: C:\\ws',
      'shell: powershell',
      '',
      '',
      'exit_code: 1'
    ].join('\n')
    expect(isRemoteGrepNoMatchContent('session', content)).toBe(true)
    expect(terminalResultOk('session', content)).toBe(true)
  })

  it('keeps ssh failures WITH output or stderr as real failures', () => {
    expect(isRemoteGrepNoMatch(sshGrepNoMatch, 1, 'some output', '')).toBe(false)
    expect(
      isRemoteGrepNoMatch(sshGrepNoMatch, 1, '', 'ssh: connect to host 127.0.0.1 port 2222: Connection refused')
    ).toBe(false)
  })

  it('keeps grep usage errors (exit 2) and quoting bugs as real failures', () => {
    expect(isRemoteGrepNoMatch(sshGrepNoMatch, 2, '', 'grep: error: No such file or directory')).toBe(false)
  })

  it('keeps non-ssh and non-grep remote commands as real failures', () => {
    expect(isRemoteGrepNoMatch('cargo test --release', 101, '', '')).toBe(false)
    expect(isRemoteGrepNoMatch('ssh host "systemctl status agentsd"', 1, '', '')).toBe(false)
  })

  it('does not fire on exit 0 or null', () => {
    expect(isRemoteGrepNoMatch(sshGrepNoMatch, 0, 'hit', '')).toBe(false)
    expect(isRemoteGrepNoMatch(sshGrepNoMatch, null, '', '')).toBe(false)
  })
})

describe('isProcessKillSweep', () => {
  // Fixture verbatim from run 82889e99 (2026-08-31): the agent killed a wedged
  // vitest tree; both PIDs confirmed killed, follow-up probe found no
  // survivors, but taskkill's raced-PID exit 128 rendered the row red as
  // "failed (128)" and fed the consecutive tool-failure streak.
  const sweepCommand =
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -match \'vitest\' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>$null | Out-Null; Write-Output ("killed " + $_.ProcessId) }; Write-Output ("vitest alive after: " + [bool](Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -match \'vitest\' }))'

  it('classifies a confirmed kill sweep with exit 128 as informative', () => {
    expect(
      isProcessKillSweep(sweepCommand, 128, 'killed 21920\nkilled 19720\nvitest alive after: False', '')
    ).toBe(true)
  })

  it('classifies through the terminal frame and via terminalResultOk', () => {
    const content = [
      'session_id: 4d10347e-1774-4531-9b5d-de8f7355735d',
      'status: done',
      `command: ${sweepCommand}`,
      'cwd: C:\\ws',
      'shell: powershell',
      '',
      'killed 21920',
      'killed 19720',
      'vitest alive after: False',
      '',
      'exit_code: 128'
    ].join('\n')
    expect(isProcessKillSweepContent('session', content)).toBe(true)
    expect(terminalResultOk('session', content)).toBe(true)
  })

  it('keeps unconfirmed sweeps (no killed PIDs) as real failures', () => {
    expect(isProcessKillSweep(sweepCommand, 128, 'vitest alive after: True', '')).toBe(false)
  })

  it('keeps plain taskkill invocations without a process enumeration as real failures', () => {
    expect(isProcessKillSweep('taskkill /PID 4242 /F', 128, 'killed 4242', '')).toBe(false)
  })

  it('keeps access-denied sweeps as real failures', () => {
    expect(
      isProcessKillSweep(sweepCommand, 128, 'killed 21920', 'Access is denied.')
    ).toBe(false)
  })

  it('does not fire on other exit codes', () => {
    expect(isProcessKillSweep(sweepCommand, 1, 'killed 21920', '')).toBe(false)
    expect(isProcessKillSweep(sweepCommand, 0, 'killed 21920', '')).toBe(false)
  })
})

describe('terminalResultOk (barrel wiring)', () => {
  it('both import paths classify the same', () => {
    const probe =
      'cwd: w\nshell: powershell\n\nstderr:\npodman : The term \'podman\' is not recognized as the name of a cmdlet\nexit_code: 1'
    const ok = 'cwd: w\nshell: powershell\n\nexit_code: 0'
    const realFail =
      'cwd: w\nshell: powershell\n\nstderr:\nerror: could not compile\nexit_code: 101'
    expect(terminalResultOk('podman --version', probe)).toBe(true)
    expect(terminalResultOk('podman --version', ok)).toBe(true)
    expect(terminalResultOk('cargo test', realFail)).toBe(false)
  })

  it('real build failures still count as failures', () => {
    const content =
      'cwd: w\nshell: powershell\n\nstderr:\nerror[E0308]: mismatched types\nexit_code: 101'
    expect(terminalResultOk('cargo test --release', content)).toBe(false)
  })
})
