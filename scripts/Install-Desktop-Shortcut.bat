@echo off
REM ============================================================================
REM  Creates a Desktop shortcut "Worldly" that launches the game (Worldly.bat)
REM  and uses the custom app icon (assets/worldly.ico). Double-click to install.
REM ============================================================================
setlocal
set "TARGET=%~dp0..\Worldly.bat"
set "WORKDIR=%~dp0.."
set "ICON=%~dp0..\assets\worldly.ico"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d=[Environment]::GetFolderPath('Desktop');" ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$d\Worldly.lnk\");" ^
  "$s.TargetPath='%TARGET%';" ^
  "$s.WorkingDirectory='%WORKDIR%';" ^
  "$s.IconLocation='%ICON%';" ^
  "$s.Description='Worldly - World Knowledge & Culture';" ^
  "$s.Save()"

if errorlevel 1 (
  echo [ERROR] Could not create the shortcut.
) else (
  echo Done. A "Worldly" shortcut with the custom icon is on your Desktop.
)
pause
endlocal
