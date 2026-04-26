@echo off
setlocal
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 20+ and reopen this launcher.
  pause
  popd
  exit /b 1
)
node ".\launcher.cjs" %*
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo Launcher exited with code %EXIT_CODE%.
  pause
)
popd
exit /b %EXIT_CODE%
