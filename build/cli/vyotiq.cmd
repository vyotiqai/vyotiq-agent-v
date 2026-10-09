@echo off
rem Agent V on the command line. Settings, General, Command line puts this
rem folder on your PATH (path-entry.ps1 beside this file).
rem
rem   vyotiq                       open Agent V
rem   vyotiq <folder>              open a folder as a workspace (. is this one)
rem   vyotiq --prompt "..." [...]  run one task with no window (Headless runs)
rem
rem A first argument starting with - runs headless: the options are those of
rem Vyotiq --headless. cmd re-reads ^ & | < > inside arguments, so pass a
rem prompt with those through --prompt-file or stdin.
rem
rem VYOTIQ_APP  another Vyotiq.exe to run instead of the one this ships with.
setlocal
set "APP=%~dp0..\..\Vyotiq.exe"
if defined VYOTIQ_APP set "APP=%VYOTIQ_APP%"
if not exist "%APP%" goto missing

set "FIRST=%~1"
if defined FIRST if "%FIRST:~0,1%"=="-" goto headless
start "" "%APP%" %*
exit /b 0

:headless
rem Vyotiq.exe is a windowed program: start /wait /b keeps it on this console
rem and returns its exit code.
start "" /wait /b "%APP%" --headless %*
exit /b %ERRORLEVEL%

:missing
echo vyotiq: no Agent V at "%APP%" 1>&2
exit /b 2
