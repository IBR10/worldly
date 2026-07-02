@echo off
setlocal
title Worldly - World Knowledge ^& Culture

REM ----- Configuration --------------------------------------------------------
set "PROJECT_DIR=C:\Users\isaac\Documents\GitHub\PersonalProjects\Worldly"
set "PORT=8000"
set "PYEXE=C:\Users\isaac\anaconda3\python.exe"
REM ---------------------------------------------------------------------------

echo.
echo  ===========================================================
echo                        WORLDLY
echo         World Knowledge, Culture ^& Current Events
echo  ===========================================================
echo.
echo   Serving at : http://localhost:%PORT%
echo   Project    : %PROJECT_DIR%
echo.
echo   Close this window to stop the game server.
echo  -----------------------------------------------------------
echo.

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
    echo [ERROR] Project directory not found: %PROJECT_DIR%
    pause
    exit /b 1
)

REM Fall back to PATH python if the anaconda interpreter isn't present.
if not exist "%PYEXE%" set "PYEXE=python"

REM Open the browser a moment after the server starts (detached helper so the
REM server itself stays in the foreground and stops when this window closes).
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%/index.html"

"%PYEXE%" -m http.server %PORT%

echo.
echo  -----------------------------------------------------------
echo   Worldly server stopped. Press any key to close.
echo  -----------------------------------------------------------
pause >nul
endlocal
