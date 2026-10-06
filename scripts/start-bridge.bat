@echo off
rem ============================================================================
rem  start-bridge.bat -- click-to-run launcher for the Codex <-> DSH bridge
rem
rem  Starts the web console (8792) and the relay broker (8791), then opens the
rem  page. Safe to run twice: an already-listening port is reused, not duplicated.
rem
rem  Double-click this file to start and open the page. Run it from cmd with
rem  arguments to do anything else:
rem
rem     start-bridge.bat --status
rem     start-bridge.bat --stop
rem     start-bridge.bat --port 8899
rem     start-bridge.bat --codex-home D:\x\.codex --dsh-home D:\x\.dsh
rem
rem  --open is added automatically ONLY when no arguments are given, so a
rem  diagnostic command never hijacks the browser.
rem
rem  Preference order: Python launcher (py) -> python -> PowerShell fallback.
rem ============================================================================

setlocal EnableExtensions
set "HERE=%~dp0"
cd /d "%HERE%"

set "PY_SCRIPT=%HERE%start-bridge.py"
set "PS_SCRIPT=%HERE%start-console.ps1"
set "EXTRA="
if "%~1"=="" set "EXTRA=--open"

rem --- prefer the official Python launcher, which picks a real interpreter -----
where py >nul 2>nul
if not errorlevel 1 (
  if exist "%PY_SCRIPT%" (
    py -3 "%PY_SCRIPT%" %* %EXTRA%
    goto :done
  )
)

rem --- then plain python on PATH ------------------------------------------------
where python >nul 2>nul
if not errorlevel 1 (
  if exist "%PY_SCRIPT%" (
    rem Guard against the Microsoft Store placeholder: it exits non-zero and opens
    rem the Store instead of running the script.
    python -c "import sys; sys.exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>nul
    if not errorlevel 1 (
      python "%PY_SCRIPT%" %* %EXTRA%
      goto :done
    )
  )
)

rem --- last resort: PowerShell launcher (no Python needed) ---------------------
if exist "%PS_SCRIPT%" (
  echo Python not found; falling back to PowerShell...
  if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -Open
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
  )
  goto :done
)

echo.
echo ERROR: neither start-bridge.py nor start-console.ps1 was found next to this file.
echo        Expected in: %HERE%
echo.

:done
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="0" (
  echo.
  echo Bridge is running. If the browser did not open, visit:
  echo    http://127.0.0.1:8792/
) else (
  echo.
  echo The launcher exited with code %EXITCODE%.
)
echo.
echo Press any key to close this window.
pause >nul
endlocal & exit /b %EXITCODE%
