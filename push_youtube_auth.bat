@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push-youtube-auth.ps1" %*
exit /b %errorlevel%
