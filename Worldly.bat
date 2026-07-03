@echo off
REM ============================================================
REM  Worldly - desktop launcher
REM  Serves the game locally and opens it in your browser.
REM  Self-locating: runs from wherever this file lives.
REM ============================================================
setlocal
cd /d "%~dp0"
title Worldly

REM Prefer the Anaconda interpreter; fall back to whatever python is on PATH.
set "PYTHON=C:\Users\isaac\anaconda3\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"

echo Starting Worldly at http://localhost:8000 ...
echo Close this window (or Ctrl+C) to stop the server.
start "" "http://localhost:8000"
REM No-cache server so the browser always loads the current build (not a stale copy).
"%PYTHON%" "%~dp0scripts\serve.py" 8000
endlocal
