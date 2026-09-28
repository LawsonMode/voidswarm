@echo off
rem Voidswarm - host the whole game on this PC for your home or classroom network.
rem Double-click this file. It runs host-local.ps1 (in this same folder) and keeps
rem this window open if something goes wrong. Close the window to stop hosting.
rem Options pass through, e.g. from a terminal:  scripts\host-local.bat -Port 7778
rem Guide: docs\LOCAL-HOSTING.md
setlocal
title Voidswarm server
if not exist "%~dp0host-local.ps1" (
  echo Voidswarm can't start from inside the ZIP.
  echo Right-click the ZIP, choose Extract All, then run scripts\host-local.bat from the extracted folder.
  echo.
  pause
  exit /b 1
)
cd /d "%~dp0.."
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0host-local.ps1" -NoPause %*
set "VS_EXIT=%ERRORLEVEL%"
if not "%VS_EXIT%"=="0" (
  echo.
  echo If something went wrong, the reason is shown above.
  pause
)
endlocal & exit /b %VS_EXIT%
