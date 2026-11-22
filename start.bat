@echo off
setlocal
title Asset Forge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Download the LTS version from https://nodejs.org, install it, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\sdk\package.json" (
  echo First start: installing one dependency. This takes a moment...
  call :install
  if not exist "node_modules\@anthropic-ai\sdk\package.json" (
    echo.
    echo The install failed. Check your internet connection and run this file again.
    pause
    exit /b 1
  )
)

node server.js
echo.
echo Asset Forge has stopped.
pause
exit /b 0

:install
rem Use the npm that ships next to node.exe, so a broken global npm does not matter.
for /f "delims=" %%i in ('where node') do (
  if exist "%%~dpinode_modules\npm\bin\npm-cli.js" (
    node "%%~dpinode_modules\npm\bin\npm-cli.js" install --no-fund --no-audit
    exit /b
  )
)
call npm install --no-fund --no-audit
exit /b
