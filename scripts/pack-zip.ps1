# Build the distributable zip for end users:  powershell -File scripts\pack-zip.ps1
# Excludes node_modules/.runtime/.git/dist - users get them via `npm install` in setup.bat.
#
# Uses bsdtar (ships with Windows 10+) instead of Compress-Archive: tar writes '/'
# as the zip entry separator, while PowerShell 5.1's Compress-Archive writes '\',
# which some macOS/Linux unzip tools extract as literal backslash file names.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$name = "webai-bridge-$($pkg.version)"

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

Push-Location $root
try {
  tar -a -cf $zip `
    --exclude node_modules `
    --exclude .runtime `
    --exclude .git `
    --exclude dist `
    .
  if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host "Created: $zip"
