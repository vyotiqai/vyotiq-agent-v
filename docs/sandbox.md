# Command sandbox

Settings → Tools → Sandbox puts the commands the agent runs inside an OS
sandbox. It is off by default (`agentSandbox: { mode: 'off', network: 'allow' }`
in settings), so nothing changes until you turn it on. The code is in
`src/main/agent/sandbox/`.

## What runs inside it

| Path | Sandboxed |
| --- | --- |
| `terminal` tool, foreground and background sessions | yes |
| `run_tests` | yes |
| `diagnostics` (typecheck, lint) | yes |
| Agent-built tools (`build_tool` modules) | **refused** while the sandbox is on — see below |
| The Terminal panel you type into | **no**, never |
| Hooks, git operations the app performs itself, stdio MCP servers | no |

The result of every sandboxed command carries a `sandbox:` line (for example
`sandbox: workspace-write via bubblewrap, network denied`), so the run record
says which commands were confined. When a sandboxed command fails with output
that looks like a denial (`Operation not permitted`, `Read-only file system`,
or, with the network denied, a DNS or unreachable-network error), the result
ends with a one-line `[sandbox]` hint so the agent stops retrying it.

## What it confines

With **Workspace only** on, a sandboxed command:

- **reads** anything except the app's data folder (Electron `userData`:
  settings, sessions, logs) and `~/.ssh`;
- **writes** only to the workspace (the task worktree when there is one),
  that workspace's git directory — for a linked worktree, the main checkout's
  `.git` too, or `git commit` would fail — the OS temp folders, and the package
  caches that already exist (`~/.npm`, the pnpm store, yarn, bun, pip, cargo,
  go, gradle, maven);
- **cannot write** the git `hooks` folder or `config` file, even inside the
  workspace: either one makes your own, unsandboxed `git` run code later. So
  `git push -u` and `git config` fail inside the sandbox;
- with **Network: Deny**, cannot reach the network.

A deeper rule wins over the one it sits in: a task worktree lives inside the
app's data folder and is still writable, and `~/.ssh` stays hidden when the
workspace is your home folder.

## Per OS

**macOS** wraps the command in `/usr/bin/sandbox-exec` with a generated
Seatbelt profile: allow by default, deny every file write, allow writes back
for the paths above, then deny reads of the hidden paths. Paths go in as `-D`
parameters, never spliced into the profile text. Network deny keeps localhost
and Unix sockets, so a local dev server or test fixture still answers.
`sandbox-exec` is deprecated by Apple but still ships and works.

**Linux** wraps it in `bwrap` (bubblewrap): the root bound read-only, the
writable paths bound read-write, an empty tmpfs over each hidden path, a fresh
`/dev`, `/proc` and PID namespace, and `--unshare-net` for network deny (the
command then has only its own loopback — the host's localhost is unreachable
too). If `bwrap` is missing, or installed but unable to create a sandbox
(unprivileged user namespaces turned off), the Settings control is disabled
with that reason, and a command the agent runs while the setting is on fails
with a clear error rather than running unsandboxed.

**Windows** runs the command at low integrity (`windows.ts`, `windowsSetup.ts`).
Windows starts a program at the lower of the user's integrity level and the
mandatory label on its executable file, and children inherit it; a
low-integrity process cannot write anything labelled medium, which every file
is by default. So:

- The capability check copies `cmd.exe` and Windows PowerShell's
  `powershell.exe` into `<userData>/sandbox/` as `cmd-low.exe` and
  `powershell-low.exe`, labels the copies low with `icacls`, and proves a
  command started from the cmd copy runs with the low mandatory SID
  (`S-1-16-4096`, the same in every language).
- Before the first command, the writable paths are labelled low with
  inheritance (`icacls <dir> /setintegritylevel (OI)(CI)low`), which reaches
  every file already inside — about 7,700 files a second, so a 200,000-file
  workspace waits half a minute once. Git `hooks` and `config` are then
  labelled medium again, so they stay read-only. Labels are remembered in
  `<userData>/sandbox/labels.json` with each path's creation time, so a folder
  is labelled again only when it is made anew (a recreated task worktree).
- Temp is `%USERPROFILE%\AppData\LocalLow\Vyotiq\sandbox-temp` (LocalLow is
  low already); `TEMP` and `TMP` point there.
- Windows PowerShell and cmd commands run from their low copies with their
  arguments untouched. Anything else goes through the cmd copy as
  `cmd /d /s /c "<line>"`, every cmd metacharacter caret-escaped (the
  cross-spawn shape), so the program gets exactly the command line it would
  have got. cmd's line cannot hold a newline and stops at 8,191 characters, so
  a PowerShell 7 (`pwsh`) script is written to a `.ps1` file first.
- **bash cannot run**: Git Bash's MSYS runtime and WSL's launcher both die at
  low integrity (MSYS cannot create its shared objects there), and so do Git
  for Windows' MSYS tools. A bash command fails at once with that reason. Git
  itself works; a git hook written in sh does not.
- It **cannot block reads or the network**: hidden paths are only kept
  unwritable (labelled medium when a writable folder holds them), and
  Network: Deny is refused with the reason rather than ignored. Settings shows
  the Network row disabled on Windows.
- Turning the sandbox off sets every path it labelled low back to medium,
  which is what an unlabelled file already is. Removing a workspace does the
  same for the paths at or inside it.

A low-labelled workspace can be written by any low-integrity process on the
machine, not only the agent's. Few programs run at low integrity today; the
labels come off when the sandbox is turned off, when the workspace is removed,
and at uninstall: `build/installer.nsh` runs
`build/uninstall/restore-sandbox-labels.ps1` over `<userData>/sandbox/labels.json`
before the app data goes (not when the uninstaller runs for an update).

## Agent-built tools

`build_tool` modules run in an Electron utility process. Electron starts that
process itself, so there is no command line to put `sandbox-exec` or `bwrap` in
front of. While the sandbox is on, calling one returns an error telling the
agent to use the terminal tool instead; nothing runs unconfined behind a
setting that says it is confined.

## Limits

- It confines files and network, not everything: with `(allow default)` on
  macOS, a command can still talk to system services over Mach IPC, and on
  both OSes it can read every file you can except the hidden ones.
- Package caches that do not exist yet are not writable, so a first-ever
  install into a new cache fails inside the sandbox. Run that install once
  outside it.
- Commands keep the cleaned environment the terminal tool always used; the
  sandbox adds nothing to it.

## Tests

- `tests/main/unit/sandboxPolicy.test.ts` — the rule list, worktree git dirs,
  depth ordering, the Seatbelt profile and bwrap argv, the denial hint
- `tests/main/unit/sandboxCapability.test.ts` — detection per platform
- `tests/main/unit/terminalSandbox.test.ts` — the wrapper is applied only when
  a sandbox is passed, and the `sandbox:` line and hint in the result
- `tests/main/unit/sandboxWindows.test.ts` — quoting and escaping, the Windows
  rules and label order, labelling once and again for a recreated folder,
  restoring, Network: Deny refused, and (on Windows) a real run: writes inside
  the workspace, denied outside it and in `.git\config`, arguments intact
