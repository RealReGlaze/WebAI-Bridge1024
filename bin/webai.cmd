@echo off
rem WebAI Bridge launcher: run tsx src/index.ts from the project root, callable from any directory
rem Example: webai.cmd ci "fix failing tests" -C E:\proj --yes
chcp 65001 >nul
pushd "%~dp0.."
if not exist "node_modules\.bin\tsx.cmd" (
  echo [webai] node_modules not found. Run "npm.cmd install" in the project root first.
  popd
  exit /b 1
)
call node_modules\.bin\tsx.cmd src\index.ts %*
popd
