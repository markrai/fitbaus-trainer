@echo off
setlocal enabledelayedexpansion

REM Always run from the folder where this batch file lives (project root)
cd /d "%~dp0"

echo Deploying FitBaus Trainer to Android device...
echo.

REM Optional: pass an adb device id as the first argument
set "TARGET=%~1"

echo Building native web assets and syncing Capacitor Android project...
call npm run cap:sync:android
if %errorlevel% neq 0 (
    echo ERROR: Android sync failed.
    exit /b 1
)
echo.

where adb >nul 2>&1
if %errorlevel% == 0 (
    echo Connected Android devices:
    adb devices
    echo.
) else (
    echo NOTE: adb not found on PATH. Ensure Android SDK platform-tools are installed.
    echo.
)

if not "%TARGET%"=="" (
    echo Installing on target device: %TARGET%
    npx --yes cap run android --no-sync --target "%TARGET%"
) else (
    echo Installing on available Android device/emulator...
    echo If multiple devices are connected, you will be prompted to choose one.
    npx --yes cap run android --no-sync
)

if %errorlevel% neq 0 (
    echo.
    echo ERROR: Deploy failed.
    echo Make sure a device/emulator is connected with USB debugging enabled.
    exit /b 1
)

echo.
echo Done. App should be launching on the device.
endlocal
