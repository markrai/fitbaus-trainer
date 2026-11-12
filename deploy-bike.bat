@echo off
setlocal enabledelayedexpansion

REM Build the FitBaus Bike Bridge (native Kotlin) and install it on the ProForm console.
REM
REM Usage:
REM   deploy-bike.bat                  production build to the default console address
REM   deploy-bike.bat 192.168.1.50     production build to another console (port 5555 assumed)
REM   deploy-bike.bat staging          debug build (com.fitbaus.bikebridge.native) instead
REM
REM The console address can also come from the FITBAUS_BIKE_ADB environment variable.
REM Every adb call is qualified with -s: other Android devices may be attached.
REM Installs with "adb install -r" so pairing data is kept. Never uninstalls.

cd /d "%~dp0"

set "BIKE=%FITBAUS_BIKE_ADB%"
if "%BIKE%"=="" set "BIKE=192.168.1.226:5555"
set "FLAVOR=production"
for %%A in (%*) do (
    if /i "%%~A"=="staging" (
        set "FLAVOR=staging"
    ) else if /i "%%~A"=="production" (
        set "FLAVOR=production"
    ) else (
        set "BIKE=%%~A"
    )
)
if "%BIKE::=%"=="%BIKE%" set "BIKE=%BIKE%:5555"

set "NATIVE=%~dp0equipment-bridges\proform-smart-power-10\native"
set "IDENTITY_PS1=%~dp0equipment-bridges\proform-smart-power-10\scripts\native-apk-identity.ps1"
if /i "%FLAVOR%"=="production" (
    set "GRADLE_TASK=:bridge-app:assembleRelease"
    set "GRADLE_ARGS=-PbridgeIdentity=production"
    set "APK=%NATIVE%\bridge-app\build\outputs\apk\release\bridge-app-release.apk"
    set "PACKAGE=com.fitbaus.bikebridge"
) else (
    set "GRADLE_TASK=:bridge-app:assembleDebug"
    set "GRADLE_ARGS="
    set "APK=%NATIVE%\bridge-app\build\outputs\apk\debug\bridge-app-debug.apk"
    set "PACKAGE=com.fitbaus.bikebridge.native"
)

echo FitBaus Bike Bridge deploy
echo   console : !BIKE!
echo   build   : %FLAVOR% (%PACKAGE%)
echo.

REM ---- tools ---------------------------------------------------------------------------
set "ADB="
for /f "delims=" %%P in ('where adb 2^>nul') do if not defined ADB set "ADB=%%P"
if not defined ADB if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not defined ADB if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools\adb.exe" set "ADB=%ANDROID_HOME%\platform-tools\adb.exe"
if not defined ADB if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools\adb.exe" set "ADB=%ANDROID_SDK_ROOT%\platform-tools\adb.exe"
if not defined ADB (
    echo ERROR: adb not found. Install Android SDK platform-tools or add adb to PATH.
    exit /b 1
)

REM The bridge build needs JDK 21. Prefer the Microsoft JDK 21 if it is installed.
for /d %%J in ("%ProgramFiles%\Microsoft\jdk-21*") do set "JAVA_HOME=%%~J"
if not defined JAVA_HOME (
    echo ERROR: JAVA_HOME is not set and no JDK 21 was found under "%ProgramFiles%\Microsoft".
    exit /b 1
)
echo Using JAVA_HOME=%JAVA_HOME%
echo.

REM ---- connect -------------------------------------------------------------------------
echo Connecting to the console...
"%ADB%" connect !BIKE! >nul 2>&1
set "STATE="
for /f "delims=" %%S in ('"%ADB%" -s !BIKE! get-state 2^>nul') do set "STATE=%%S"
if /i not "!STATE!"=="device" (
    echo ERROR: console !BIKE! is not reachable over adb ^(state: "!STATE!"^).
    echo Check that the bike is on, on this network, and that adb over TCP is enabled on port 5555.
    "%ADB%" devices -l
    exit /b 1
)
echo Console connected.
echo.

REM ---- build ---------------------------------------------------------------------------
echo Building %GRADLE_TASK% %GRADLE_ARGS% ...
pushd "%NATIVE%"
call gradlew.bat %GRADLE_TASK% %GRADLE_ARGS% --console=plain
set "BUILD_RESULT=%errorlevel%"
popd
if not "%BUILD_RESULT%"=="0" (
    echo.
    echo ERROR: build failed.
    exit /b 1
)
if not exist "%APK%" (
    echo ERROR: build finished but the APK is missing: %APK%
    exit /b 1
)

echo.
echo Verifying the APK identity...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { . '%IDENTITY_PS1%'; $id = Assert-ApkQualificationIdentity -ApkPath '%APK%' -ExpectedApplicationId '%PACKAGE%' -ExpectedUnlock 'off'; Write-Host ('  ' + $id.ApplicationId + ', unlockQualification=' + $id.UnlockQualification); exit 0 } catch { Write-Host ('  ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
    echo ERROR: the APK identity does not match %PACKAGE%. Not installing.
    exit /b 1
)
echo.

REM ---- install -------------------------------------------------------------------------
echo Installing on !BIKE! ^(keeps pairing data^)...
set "INSTALL_LOG=%TEMP%\fitbaus-bike-install.log"
"%ADB%" -s !BIKE! install -r "%APK%" > "%INSTALL_LOG%" 2>&1
type "%INSTALL_LOG%"
findstr /c:"Success" "%INSTALL_LOG%" >nul
if errorlevel 1 (
    echo.
    echo ERROR: install failed.
    findstr /c:"INSTALL_FAILED_UPDATE_INCOMPATIBLE" "%INSTALL_LOG%" >nul && (
        echo The APK signature does not match the app already on the console.
        echo Production builds must be signed with the installed certificate ^(see native\local.properties^).
        echo Do NOT uninstall the existing app: that would erase its pairing data.
    )
    exit /b 1
)
echo.

REM ---- launch --------------------------------------------------------------------------
echo Stopping stock iFIT ^(Wolf / ERU^) so the bridge can own USB...
"%ADB%" -s !BIKE! shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
echo Launching %PACKAGE%...
"%ADB%" -s !BIKE! shell monkey -p %PACKAGE% -c android.intent.category.LAUNCHER 1 >nul
if errorlevel 1 (
    echo WARNING: could not launch %PACKAGE%. Start it from the console launcher.
    exit /b 1
)

echo.
echo Done. %PACKAGE% is installed and launching on !BIKE!.
endlocal
