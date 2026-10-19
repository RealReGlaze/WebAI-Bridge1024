@echo off
setlocal EnableExtensions
rem ============================================================
rem  WebAI Bridge - one-click setup for Windows
rem  Double-click this file, or run "setup.bat" from a terminal.
rem
rem  Steps performed:
rem    1. Ensure Node.js >= 20 (auto-install via winget if possible)
rem    2. npm install (all dependencies are project-local)
rem    3. Add <install>\bin to your user PATH + set WEBAI_HOME
rem    4. Verify the "webai" launcher works
rem ============================================================

chcp 65001 >nul
title WebAI Bridge Setup

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo ============================================================
echo   WebAI Bridge Setup
echo   Install directory: %ROOT%
echo ============================================================
echo.

rem ---------- [1/4] Node.js ----------
echo [1/4] Checking Node.js...
set "NODE_MAJOR="
for /f "delims=" %%i in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%i"
if not defined NODE_MAJOR goto node_missing
if %NODE_MAJOR% LSS 20 goto node_missing
goto node_ok

:node_missing
echo       Node.js 20+ not found. Trying automatic install via winget...
where winget >nul 2>nul
if errorlevel 1 goto node_manual
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto node_manual
rem Make node visible to the current session immediately
set "PATH=%PATH%;%ProgramFiles%\nodejs"
set "NODE_MAJOR="
for /f "delims=" %%i in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%i"
if not defined NODE_MAJOR goto node_manual
if %NODE_MAJOR% LSS 20 goto node_manual
echo       Node.js installed successfully.
goto node_ok

:node_manual
echo.
echo   [ERROR] Node.js 20+ is required but was not found.
echo   Please install the LTS version from https://nodejs.org/
echo   and then run this setup again.
goto fail

:node_ok
echo       OK: Node.js v%NODE_MAJOR%.x
echo.

rem ---------- [2/4] Dependencies ----------
echo [2/4] Installing dependencies (npm install, project-local only)...
where npm.cmd >nul 2>nul
if errorlevel 1 goto npm_missing
pushd "%ROOT%"
rem Call npm.cmd explicitly: npm.ps1 is blocked by the default PowerShell
rem execution policy on many systems (see docs/README.md).
call npm.cmd install --no-audit --no-fund
set "NPM_EL=%ERRORLEVEL%"
popd
if not "%NPM_EL%"=="0" goto npm_fail
echo       OK: dependencies installed.
echo.
goto step3

:npm_missing
echo   [ERROR] npm.cmd not found. Your Node.js installation looks incomplete.
goto fail

:npm_fail
echo   [ERROR] npm install failed (exit code %NPM_EL%).
echo   Check your network/proxy settings, then run "npm install" in:
echo     %ROOT%
goto fail

:step3
rem ---------- [3/4] Environment variables ----------
echo [3/4] Configuring environment (user PATH + WEBAI_HOME)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\win-env.ps1" -Action add -BinDir "%ROOT%\bin" -HomeDir "%ROOT%"
if errorlevel 1 goto env_fail
echo       OK. Open a NEW terminal so the PATH update takes effect.
echo.
goto step4

:env_fail
echo   [ERROR] Failed to update user environment variables.
goto fail

:step4
rem ---------- [4/4] Browser + runtime verification ----------
echo [4/4] Final checks...
set "EDGE_EXE="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "EDGE_EXE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
if not defined EDGE_EXE goto edge_missing
echo       OK: Edge found.
goto verify

:edge_missing
echo       [WARN] Microsoft Edge was not found in the default locations.
echo       WebAI Bridge drives your local Edge browser via CDP.
echo       Install it from https://www.microsoft.com/edge/download
echo       (or set "browser.executablePath" in config/backends.json)

:verify
pushd "%ROOT%"
call node_modules\.bin\tsx.cmd --version >nul 2>nul
set "TSX_EL=%ERRORLEVEL%"
popd
if not "%TSX_EL%"=="0" goto verify_fail
echo       OK: runtime (tsx) is working.
echo.
goto success

:verify_fail
echo   [ERROR] Runtime verification failed. Try "npm install" inside %ROOT%.
goto fail

:success
echo ============================================================
echo   Setup finished successfully!
echo.
echo   Next steps:
echo     1. Open a NEW terminal window (so PATH updates load).
echo     2. Run:  webai
echo        (first run opens a dedicated Edge window; log in once)
echo     3. One-shot tasks:  webai ci "your task here"
echo.
echo   To remove this installation later, run uninstall.bat
echo ============================================================
set "EXITCODE=0"
goto end

:fail
echo.
echo   Setup FAILED. See the messages above.
set "EXITCODE=1"

:end
rem Pause only when launched by double-click, not from an open terminal
echo %cmdcmdline% | find /i "%~nx0" >nul && (echo. & pause)
exit /b %EXITCODE%
