@echo off
setlocal
cd /d "%~dp0"
node src\standalone-control.mjs start %*
if errorlevel 1 (
  echo.
  echo The Micro host stopped with an error. See the message above and docs\windows.md.
  pause
  exit /b 1
)
