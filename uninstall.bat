@echo off
setlocal EnableExtensions
rem WebAI Bridge - uninstall for Windows: removes user PATH entry + WEBAI_HOME.
rem Does NOT delete any files; delete the install folder manually if desired.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo Removing WebAI Bridge environment entries...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\scripts\win-env.ps1" -Action remove -BinDir "%ROOT%\bin" -HomeDir "%ROOT%"
if errorlevel 1 (
  echo   [ERROR] Failed to update user environment variables.
  exit /b 1
)
echo.
echo Done. The install folder was NOT deleted:
echo   %ROOT%
echo You may delete it manually. Note: browser login profiles live in
echo   %ROOT%\.runtime\
echo and contain no credentials - deleting them just logs you out of the web AIs.
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b 0
