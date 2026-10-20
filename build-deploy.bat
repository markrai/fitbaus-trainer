@echo off
setlocal
echo Building and preparing deploy folder...
echo.
REM npm run build runs prebuild (syncs version.js -> src/version.ts + package.json) then tsc
call npm run build
if %errorlevel% neq 0 (
    echo Build failed.
    exit /b 1
)

if exist deploy rmdir /s /q deploy
mkdir deploy
mkdir deploy\dist

copy /y index.html deploy\ >nul
copy /y styles.css deploy\ >nul
copy /y favicon.ico deploy\ >nul
copy /y settings.svg deploy\ >nul
if exist logo.png copy /y logo.png deploy\ >nul
copy /y sw.js deploy\ >nul
copy /y data.json deploy\ >nul
if exist manifest.json copy /y manifest.json deploy\ >nul
copy /y heart.png deploy\ >nul
copy /y bike.png deploy\ >nul
copy /y dumbbell.png deploy\ >nul
copy /y elliptical.png deploy\ >nul

xcopy /E /Y dist\* deploy\dist\ >nul

echo.
echo Deploy folder ready: deploy\
echo Upload the contents of the "deploy" folder to your web server.
endlocal
