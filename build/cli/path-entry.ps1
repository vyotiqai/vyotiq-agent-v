# The `vyotiq` command on PATH: one entry, the folder holding vyotiq.cmd, in
# your user PATH. Run by the app (Settings, General, Command line; see
# src/main/app/cliPath.ts) and by the uninstaller (build/installer.nsh), which
# takes it out.
#
#   -Action status|add|remove  -Dir <folder>
#   -Value <PATH>   work on this string instead of the registry and print the
#                   result (for tests)
#
# Only HKCU\Environment\Path changes, and in it only entries naming -Dir:
# every other entry stays as written, %VARIABLES% unexpanded, and the value
# keeps its registry type. Prints {"onPath":true|false}.
param(
  [Parameter(Mandatory = $true)][ValidateSet('status', 'add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Value
)
$ErrorActionPreference = 'Stop'

function Test-Entry([string]$entry) {
  $a = $entry.Trim().Trim('"').TrimEnd('\')
  $b = $Dir.Trim().Trim('"').TrimEnd('\')
  return $a -ne '' -and [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
}

function Test-OnPath([string]$path) {
  if (-not $path) { return $false }
  return @($path -split ';' | Where-Object { Test-Entry $_ }).Count -gt 0
}

function Get-Changed([string]$path) {
  $has = Test-OnPath $path
  if ($Action -eq 'add' -and -not $has) {
    if (-not $path) { return $Dir }
    if ($path.EndsWith(';')) { return $path + $Dir }
    return $path + ';' + $Dir
  }
  if ($Action -eq 'remove' -and $has) {
    return (@($path -split ';' | Where-Object { -not (Test-Entry $_) }) -join ';')
  }
  return $path
}

if ($PSBoundParameters.ContainsKey('Value')) {
  [Console]::Out.Write((Get-Changed $Value))
  exit 0
}

$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $exists = $key.GetValueNames() -contains 'Path'
  $old = ''
  if ($exists) {
    $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  }
  $new = Get-Changed $old
  if ($new -cne $old) {
    if ($new -eq '') {
      $key.DeleteValue('Path', $false)
    } else {
      $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
      if ($exists) { $kind = $key.GetValueKind('Path') }
      $key.SetValue('Path', $new, $kind)
    }
    # Clearing a variable that isn't set changes nothing, but .NET then tells
    # every window the environment changed, so a terminal opened from
    # Explorer or the Start menu from now on sees the new PATH.
    [Environment]::SetEnvironmentVariable('VYOTIQ_PATH_REFRESH', $null, 'User')
  }
  [Console]::Out.Write((ConvertTo-Json @{ onPath = (Test-OnPath $new) } -Compress))
} finally {
  $key.Close()
}
