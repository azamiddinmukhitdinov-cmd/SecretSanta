@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0scripts\node-windows.cmd" scripts\run-windows.mjs access
echo.
pause
