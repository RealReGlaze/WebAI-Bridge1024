# WebAI Bridge: per-user environment variable management (called by setup.bat / uninstall.bat).
# Writes to HKCU\Environment only - no admin rights required.
#  - add:    append BinDir to the user PATH (dedup-aware) and set WEBAI_HOME = HomeDir
#  - remove: drop BinDir from the user PATH and clear WEBAI_HOME if it points at HomeDir
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$BinDir,
  [Parameter(Mandatory = $true)][string]$HomeDir
)
$ErrorActionPreference = 'Stop'

$BinDir = $BinDir.TrimEnd('\')
$HomeDir = $HomeDir.TrimEnd('\')

$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if (-not $key) { throw 'Cannot open HKCU\Environment' }

$exists = $key.GetValue('Path') -ne $null
$raw = if ($exists) {
  [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
} else { '' }
# Preserve the original value kind (usually REG_EXPAND_SZ so %VAR% entries keep working)
$kind = if ($exists) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }

$entries = @($raw -split ';' | Where-Object { $_ -ne '' })

if ($Action -eq 'add') {
  $already = $false
  foreach ($e in $entries) {
    if ($e.TrimEnd('\') -ieq $BinDir) { $already = $true; break }
  }
  if ($already) {
    Write-Host "      PATH already contains: $BinDir"
  } else {
    $new = (@($entries) + $BinDir) -join ';'
    $key.SetValue('Path', $new, $kind)
    Write-Host "      Added to user PATH: $BinDir"
  }
  $key.SetValue('WEBAI_HOME', $HomeDir, [Microsoft.Win32.RegistryValueKind]::String)
  Write-Host "      Set WEBAI_HOME = $HomeDir"
}
else {
  $kept = @($entries | Where-Object { $_.TrimEnd('\') -ine $BinDir })
  if ($kept.Count -ne $entries.Count) {
    if ($kept.Count -eq 0) {
      $key.DeleteValue('Path', $false)
    } else {
      $key.SetValue('Path', ($kept -join ';'), $kind)
    }
    Write-Host "      Removed from user PATH: $BinDir"
  } else {
    Write-Host "      PATH entry not found (already clean): $BinDir"
  }
  $curHome = [string]$key.GetValue('WEBAI_HOME', '')
  if ($curHome.TrimEnd('\') -ieq $HomeDir) {
    $key.DeleteValue('WEBAI_HOME', $false)
    Write-Host '      Removed WEBAI_HOME'
  }
}

$key.Close()

# Broadcast WM_SETTINGCHANGE so newly opened terminals pick up the change without re-login
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
"@
[UIntPtr]$result = [UIntPtr]::Zero
[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
