@echo off
rem VYOTIQ headless launcher: bin\vyotiq.cmd [options]   (docs\headless.md)
rem
rem   bin\vyotiq.cmd --cwd . --prompt "What files are here?" --mode ask --output json
rem
rem VYOTIQ_APP  path to an installed Vyotiq.exe to run instead of this checkout.
rem Otherwise this checkout runs on its own Electron; build it first:
rem   pnpm build:vite
rem
rem cmd re-reads ^ & | < > inside arguments: pass a prompt with those
rem characters through --prompt-file or stdin.
setlocal

if defined VYOTIQ_APP (
  rem Vyotiq.exe is a windowed program: start /wait /b keeps it on this
  rem console and returns its exit code.
  start "" /wait /b "%VYOTIQ_APP%" --headless %*
  exit /b %ERRORLEVEL%
)

set "REPO=%~dp0.."
if not exist "%REPO%\out\main\index.js" (
  echo vyotiq: no build in %REPO%\out - run: pnpm build:vite 1>&2
  exit /b 2
)

rem electron\cli.js (a console program) spawns Electron with this console's
rem stdio and exits with its exit code, so pipes and %ERRORLEVEL% both work.
node "%REPO%\node_modules\electron\cli.js" "%REPO%" --headless %*
exit /b %ERRORLEVEL%
