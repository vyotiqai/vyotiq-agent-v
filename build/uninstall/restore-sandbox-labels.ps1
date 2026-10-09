# Run by the uninstaller (build/installer.nsh): put back the integrity labels
# the Windows sandbox set. Without this, a workspace the sandbox labelled low
# stays writable by any low-integrity process after Agent V is gone.
#
# Reads <userData>\sandbox\labels.json, written by
# src/main/agent/sandbox/windowsSetup.ts, and does what restoreWindowsLabels
# does there: medium on each path still labelled low. Best effort; it never
# fails the uninstall.
param([Parameter(Mandatory = $true)][string]$Record)

$ErrorActionPreference = 'SilentlyContinue'
if (-not (Test-Path -LiteralPath $Record)) { exit 0 }
try {
  $labels = Get-Content -LiteralPath $Record -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  exit 0
}
if (-not $labels) { exit 0 }

$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
foreach ($entry in $labels.PSObject.Properties) {
  $label = $entry.Value
  if ($label.level -ne 'low' -or -not $label.path) { continue }
  $item = Get-Item -LiteralPath $label.path -Force
  if (-not $item) { continue }
  $level = if ($item.PSIsContainer) { '(OI)(CI)medium' } else { 'medium' }
  & $icacls $label.path /setintegritylevel $level /C /Q | Out-Null
}
exit 0
