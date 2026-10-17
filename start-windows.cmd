@echo off
setlocal
cd /d "%~dp0"
echo Secret Santa server
echo Keep this window open. Press Ctrl+C to stop the server.
call "%~dp0scripts\node-windows.cmd" scripts\run-windows.mjs start
if errorlevel 1 pause
