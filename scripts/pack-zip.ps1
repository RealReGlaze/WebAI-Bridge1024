# Build the distributable zip for end users:  powershell -File scripts\pack-zip.ps1
# Excludes node_modules/.runtime/.git/dist - users get them via `npm install` in setup.bat.
#
# Uses bsdtar (ships with Windows 10+ at C:\Windows\System32\tar.exe) instead of
# Compress-Archive: tar writes '/' as the zip entry separator, while PowerShell 5.1's
# Compress-Archive writes '\', which some macOS/Linux unzip tools extract as literal
# backslash file names.
#
# The system bsdtar is called by full path because Git for Windows puts its own
# GNU tar first on PATH; GNU tar here reads "E:\..." as an rsh host spec and fails
# ("Cannot connect to E: resolve failed").
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkgPath = Join-Path $root 'package.json'

if (-not (Test-Path $pkgPath)) {
  Write-Error "package.json not found at: $pkgPath. Run this script from the project root or scripts directory."
  exit 1
}

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $tar)) {
  $tar = (Get-Command tar.exe -All -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notmatch '\\Git\\' } |
    Select-Object -First 1).Source
}
if (-not $tar) {
  Write-Error "bsdtar (tar.exe) not found. Windows 10+ ships it at %SystemRoot%\System32\tar.exe."
  exit 1
}

$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$name = "webai-bridge-$($pkg.version)"

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

Push-Location $root
try {
  & $tar -a -cf $zip `
    --exclude node_modules `
    --exclude .runtime `
    --exclude .git `
    --exclude dist `
    .
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    throw "tar failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "Created: $zip"
