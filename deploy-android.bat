@echo off
setlocal enabledelayedexpansion

REM Always run from the folder where this batch file lives (project root)
cd /d "%~dp0"

echo Deploying FitBaus Trainer to Android...
echo.

where adb >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: adb not found on PATH. Ensure Android SDK platform-tools are installed.
    exit /b 1
)

set "REQUESTED=%~1"
set "DEVICE_COUNT=0"
set "TARGET="
set "MATCHED="

echo Available Android devices:
for /f "skip=1 tokens=1,2*" %%A in ('adb devices -l 2^>nul') do (
    set "SERIAL=%%A"
    set "STATE=%%B"
    set "DETAILS=%%C"
    if not "!SERIAL!"=="" if /i "!STATE!"=="device" (
        set /a DEVICE_COUNT+=1
        set "DEVICE_!DEVICE_COUNT!=!SERIAL!"

        set "KIND=usb"
        echo !SERIAL! | findstr /i /b /c:"emulator-" >nul
        if !errorlevel! == 0 (
            set "KIND=emulator"
        ) else (
            echo !SERIAL! | findstr /c:":" >nul
            if !errorlevel! == 0 set "KIND=wifi"
        )

        set "MODEL="
        for %%P in (!DETAILS!) do (
            set "PART=%%P"
            if /i "!PART:~0,6!"=="model:" set "MODEL=!PART:~6!"
        )
        if "!MODEL!"=="" (
            echo   !DEVICE_COUNT!. !SERIAL!  [!KIND!]
        ) else (
            echo   !DEVICE_COUNT!. !SERIAL!  [!KIND!]  !MODEL!
        )
        if /i "!SERIAL!"=="!REQUESTED!" set "MATCHED=!SERIAL!"
    )
)
echo.

if !DEVICE_COUNT! == 0 (
    echo ERROR: No authorized Android devices found.
    echo Connect a phone over USB or Wi-Fi with debugging enabled, then authorize this computer.
    echo.
    echo Current adb device list:
    adb devices -l
    exit /b 1
)

if not "!REQUESTED!"=="" (
    if "!MATCHED!"=="" (
        echo ERROR: "!REQUESTED!" is not an authorized device in the current adb list.
        echo Pass one of the serials shown above, or run without arguments to choose interactively.
        exit /b 1
    )
    set "TARGET=!MATCHED!"
) else if !DEVICE_COUNT! == 1 (
    set "TARGET=!DEVICE_1!"
    echo Using only available device: !TARGET!
) else (
    set /p "CHOICE=Select device [1-!DEVICE_COUNT!]: "
    echo !CHOICE!| findstr /r "^[1-9][0-9]*$" >nul
    if !errorlevel! neq 0 (
        echo ERROR: Invalid selection.
        exit /b 1
    )
    if !CHOICE! lss 1 (
        echo ERROR: Invalid selection.
        exit /b 1
    )
    if !CHOICE! gtr !DEVICE_COUNT! (
        echo ERROR: Invalid selection.
        exit /b 1
    )
    call set "TARGET=%%DEVICE_!CHOICE!%%"
    if "!TARGET!"=="" (
        echo ERROR: Invalid selection.
        exit /b 1
    )
)

echo.
echo Building native web assets and syncing Capacitor Android project...
call npm run cap:sync:android
if %errorlevel% neq 0 (
    echo ERROR: Android sync failed.
    exit /b 1
)
echo.

echo Installing on device: !TARGET!
npx --yes cap run android --no-sync --target "!TARGET!"
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Deploy failed.
    echo Make sure the selected device is still connected and authorized.
    exit /b 1
)

echo.
echo Done. App should be launching on the device.
endlocal
