param(
    [string]$OutputDir = "dist\portable-win",
    [string]$VersionSuffix = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$absOutputDir = Join-Path $repoRoot $OutputDir
$stageDir = Join-Path $absOutputDir "ChessBookReader-portable-win"

if (Test-Path $stageDir) {
    Remove-Item $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

function Copy-IfExists {
    param(
        [string]$RelativePath
    )
    $src = Join-Path $repoRoot $RelativePath
    if (!(Test-Path $src)) {
        throw "Missing required path: $RelativePath"
    }
    $dest = Join-Path $stageDir $RelativePath
    $destParent = Split-Path -Parent $dest
    New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    Copy-Item -Path $src -Destination $dest -Recurse -Force
}

function Copy-TreeSlim {
    param(
        [string]$SourceRel,
        [string[]]$ExcludeDirs = @("node_modules", ".venv", "__pycache__", ".pytest_cache", ".mypy_cache", "dist", "build")
    )
    $src = Join-Path $repoRoot $SourceRel
    if (!(Test-Path $src)) {
        throw "Missing required path: $SourceRel"
    }
    $dest = Join-Path $stageDir $SourceRel
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    $excludeArgs = @()
    foreach ($d in $ExcludeDirs) {
        $excludeArgs += "/XD"
        $excludeArgs += $d
    }

    # robocopy returns non-zero on successful copies (1..7), so we accept <8.
    & robocopy $src $dest /E /NFL /NDL /NJH /NJS /NP @excludeArgs | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) {
        throw "robocopy failed for $SourceRel (exit code $rc)"
    }
}

Copy-TreeSlim "apps"
Copy-IfExists "scripts\stop-dev.ps1"
Copy-IfExists "packaging\windows-portable\launcher.cjs"
Copy-IfExists "packaging\windows-portable\Run-ChessBookReader.cmd"
Copy-IfExists "README.md"
Copy-IfExists "package.json"
Copy-IfExists "package-lock.json"

$vendorRepo = Join-Path $stageDir "apps\backend\vendor\Chess_diagram_to_FEN"
if (Test-Path $vendorRepo) {
    Remove-Item $vendorRepo -Recurse -Force
}

$rootLauncherPath = Join-Path $stageDir "Run-ChessBookReader.cmd"
$rootLauncherContent = @"
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
node ".\packaging\windows-portable\launcher.cjs" %*
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo Launcher exited with code %EXIT_CODE%.
  pause
)
popd
exit /b %EXIT_CODE%
"@
Set-Content -Path $rootLauncherPath -Value $rootLauncherContent -Encoding Ascii

$setupScriptPath = Join-Path $stageDir "Setup-ChessBookReader.cmd"
$setupScriptContent = @'
@echo off
setlocal
set SCRIPT_DIR=%~dp0
pushd "%SCRIPT_DIR%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js 20+ and rerun this setup.
  pause
  popd
  exit /b 1
)

set NPM_CMD=npm.cmd
where npm.cmd >nul 2>nul
if errorlevel 1 (
  for %%I in (node.exe) do set NODE_EXE=%%~$PATH:I
  if exist "%NODE_EXE%" (
    set NPM_CLI=%NODE_EXE:\node.exe=\node_modules\npm\bin\npm-cli.js%
    if exist "%NPM_CLI%" (
      set NPM_CMD="%NODE_EXE%" "%NPM_CLI%"
    )
  )
)

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found in PATH.
  echo Install Python 3.11+ and rerun this setup.
  pause
  popd
  exit /b 1
)

echo [1/3] Installing root npm dependencies...
call %NPM_CMD% install
if errorlevel 1 goto :fail

echo [2/3] Installing frontend npm dependencies...
pushd "apps\frontend"
call %NPM_CMD% install
if errorlevel 1 goto :fail
popd

if not exist "apps\backend\vendor\Chess_diagram_to_FEN" (
  echo [3/4] Downloading Chess_diagram_to_FEN vendor repository...
  where curl.exe >nul 2>nul
  if not errorlevel 1 (
    curl.exe -L --fail --retry 3 --retry-delay 2 "https://github.com/tsoj/Chess_diagram_to_FEN/archive/refs/heads/main.zip" -o "apps\backend\vendor\Chess_diagram_to_FEN-main.zip"
    if errorlevel 1 goto :fail
  )
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$vendor='apps\\backend\\vendor';" ^
    "New-Item -ItemType Directory -Path $vendor -Force | Out-Null;" ^
    "$zip=Join-Path $vendor 'Chess_diagram_to_FEN-main.zip';" ^
    "$extract=Join-Path $vendor 'Chess_diagram_to_FEN-main';" ^
    "$dest=Join-Path $vendor 'Chess_diagram_to_FEN';" ^
    "if (!(Test-Path $zip)) { Invoke-WebRequest -Uri 'https://github.com/tsoj/Chess_diagram_to_FEN/archive/refs/heads/main.zip' -OutFile $zip; }" ^
    "if (Test-Path $extract) { Remove-Item $extract -Recurse -Force };" ^
    "Expand-Archive -Path $zip -DestinationPath $vendor -Force;" ^
    "if (Test-Path $dest) { Remove-Item $dest -Recurse -Force };" ^
    "Move-Item -Path $extract -Destination $dest;" ^
    "Remove-Item $zip -Force"
  if errorlevel 1 goto :fail
)

echo [4/4] Setting up backend virtualenv and models...
call %NPM_CMD% run setup:backend
if errorlevel 1 goto :fail

echo Setup complete. You can now run Run-ChessBookReader.cmd
pause
popd
exit /b 0

:fail
echo Setup failed. Review the error output above.
pause
popd
exit /b 1
'@
Set-Content -Path $setupScriptPath -Value $setupScriptContent -Encoding Ascii

$zipName = "ChessBookReader-portable-win"
if ($VersionSuffix) {
    $zipName = "$zipName-$VersionSuffix"
}
$zipPath = Join-Path $absOutputDir "$zipName.zip"

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Output "Portable package created:"
Write-Output "  Stage: $stageDir"
Write-Output "  Zip:   $zipPath"
