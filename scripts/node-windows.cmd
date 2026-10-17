@echo off
setlocal
set "SANTA_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined SANTA_NODE set "SANTA_NODE=%%N"
if not defined SANTA_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "SANTA_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined SANTA_NODE (
  echo Node.js 24 or newer is required. Install it from https://nodejs.org/
  exit /b 1
)
"%SANTA_NODE%" %*
exit /b %errorlevel%
