@echo off
setlocal enabledelayedexpansion

REM Build (unless an explicit APK path is given), deploy the FitBaus Bike Bridge
REM APK to the ProForm console, and launch it.
REM Usage:
REM   deploy-bike.bat path\to\com.fitbaus.bikebridge-Signed.apk host:5555
REM   set BIKE_ADB=host:5555 && deploy-bike.bat
REM   deploy-bike.bat   (builds default APK; still requires BIKE_ADB or %%2)
REM
REM Required device: argument 2 or BIKE_ADB (no private default address).
REM Optional env: ADB, BIKE_ADB, BIKE_APK, MSBUILD,
REM AndroidSdkDirectory, ANDROID_HOME, JavaSdkDirectory

cd /d "%~dp0"

if not defined ADB set "ADB=adb"

set "DEVICE=%~2"
if "%DEVICE%"=="" (
  if defined BIKE_ADB (
    set "DEVICE=%BIKE_ADB%"
  )
)
if "%DEVICE%"=="" (
  echo ERROR: device required. Pass host:5555 as the second argument or set BIKE_ADB.
  echo Example: deploy-bike.bat path\to\signed.apk 192.168.1.10:5555
  exit /b 1
)

set "DEFAULT_APK=src\Fitbaus.BikeBridge.Android\bin\Debug\com.fitbaus.bikebridge-Signed.apk"
set "APK=%~1"
set "SKIP_BUILD=0"
if not "%APK%"=="" (
  set "SKIP_BUILD=1"
) else if defined BIKE_APK (
  set "APK=%BIKE_APK%"
  set "SKIP_BUILD=1"
) else (
  set "APK=%DEFAULT_APK%"
)

if "%SKIP_BUILD%"=="0" (
  call :BuildApk
  if errorlevel 1 exit /b 1
)

if not exist "%APK%" (
  echo ERROR: APK not found:
  echo   %APK%
  echo Build the signed package first, or pass the APK path as the first argument.
  exit /b 1
)

echo FitBaus Bike Bridge deploy
echo   adb:    %ADB%
echo   device: %DEVICE%
echo   apk:    %APK%
echo.

"%ADB%" connect %DEVICE%
if %errorlevel% neq 0 (
  echo ERROR: adb connect failed.
  exit /b 1
)

"%ADB%" -s %DEVICE% wait-for-device
if %errorlevel% neq 0 (
  echo ERROR: device did not come online.
  exit /b 1
)

echo Installing...
"%ADB%" -s %DEVICE% install -r "%APK%"
if %errorlevel% neq 0 (
  echo ERROR: install failed.
  exit /b 1
)

echo Stopping Wolf and ERU in one shell...
"%ADB%" -s %DEVICE% shell "am force-stop com.ifit.standalone; am force-stop com.ifit.eru"
if %errorlevel% neq 0 (
  echo ERROR: failed to stop stock packages.
  exit /b 1
)

echo Launching FitBaus Bike Bridge...
"%ADB%" -s %DEVICE% shell monkey -p com.fitbaus.bikebridge -c android.intent.category.LAUNCHER 1
if %errorlevel% neq 0 (
  echo ERROR: launch failed.
  exit /b 1
)

echo.
echo Done. Bridge should be running.
echo Health endpoint is GET http://^<console-lan-ip^>:8765/health
endlocal
exit /b 0

:BuildApk
echo Building signed Debug APK...
call :ResolveMsbuild
if errorlevel 1 exit /b 1
call :ResolveAndroidSdk
if errorlevel 1 exit /b 1
call :ResolveJavaSdk

set "PROJ=src\Fitbaus.BikeBridge.Android\Fitbaus.BikeBridge.Android.csproj"

echo   msbuild: %MSBUILD%
echo   project: %PROJ%
echo   sdk:     !AndroidSdkDirectory!
if defined JavaSdkDirectory echo   jdk:     !JavaSdkDirectory!

echo Cleaning previous XA output (avoids stale ACW / n_onCreate UnsatisfiedLinkError)...
if defined JavaSdkDirectory (
  "%MSBUILD%" "%PROJ%" /nologo /v:minimal /p:Configuration=Debug /t:Clean /p:AndroidSdkDirectory="!AndroidSdkDirectory!" /p:JavaSdkDirectory="!JavaSdkDirectory!"
) else (
  "%MSBUILD%" "%PROJ%" /nologo /v:minimal /p:Configuration=Debug /t:Clean /p:AndroidSdkDirectory="!AndroidSdkDirectory!"
)

if defined JavaSdkDirectory (
  "%MSBUILD%" "%PROJ%" /nologo /v:minimal /p:Configuration=Debug /p:AndroidSupportedAbis=x86 /t:SignAndroidPackage /p:AndroidSdkDirectory="!AndroidSdkDirectory!" /p:JavaSdkDirectory="!JavaSdkDirectory!"
) else (
  "%MSBUILD%" "%PROJ%" /nologo /v:minimal /p:Configuration=Debug /p:AndroidSupportedAbis=x86 /t:SignAndroidPackage /p:AndroidSdkDirectory="!AndroidSdkDirectory!"
)
if errorlevel 1 (
  echo ERROR: msbuild SignAndroidPackage failed.
  exit /b 1
)

if not exist "%DEFAULT_APK%" (
  echo ERROR: build succeeded but signed APK was not produced:
  echo   %DEFAULT_APK%
  exit /b 1
)

echo Build OK: %DEFAULT_APK%
echo.
exit /b 0

:ResolveAndroidSdk
if defined AndroidSdkDirectory (
  if exist "!AndroidSdkDirectory!\platforms" exit /b 0
  echo ERROR: AndroidSdkDirectory is set but invalid:
  echo   !AndroidSdkDirectory!
  exit /b 1
)
if defined ANDROID_HOME (
  if exist "%ANDROID_HOME%\platforms" (
    set "AndroidSdkDirectory=%ANDROID_HOME%"
    exit /b 0
  )
)
if defined ANDROID_SDK_ROOT (
  if exist "%ANDROID_SDK_ROOT%\platforms" (
    set "AndroidSdkDirectory=%ANDROID_SDK_ROOT%"
    exit /b 0
  )
)
if exist "%LOCALAPPDATA%\Android\Sdk\platforms" (
  set "AndroidSdkDirectory=%LOCALAPPDATA%\Android\Sdk"
  exit /b 0
)

echo ERROR: Android SDK not found. Set AndroidSdkDirectory or ANDROID_HOME
echo to your SDK root ^(needs platforms\android-24 for this project^).
exit /b 1

:ResolveJavaSdk
if defined JavaSdkDirectory (
  if exist "!JavaSdkDirectory!\bin\java.exe" exit /b 0
  echo ERROR: JavaSdkDirectory is set but invalid:
  echo   !JavaSdkDirectory!
  exit /b 1
)
REM Prefer JDK 11 for Xamarin.Android; JAVA_HOME may be a newer JDK.
if exist "%ProgramFiles%\Microsoft\jdk-11.0.32.101-hotspot\bin\java.exe" (
  set "JavaSdkDirectory=%ProgramFiles%\Microsoft\jdk-11.0.32.101-hotspot"
  exit /b 0
)
for /d %%D in ("%ProgramFiles%\Microsoft\jdk-11*") do (
  if exist "%%~D\bin\java.exe" (
    set "JavaSdkDirectory=%%~D"
    exit /b 0
  )
)
for /d %%D in ("%ProgramFiles%\Eclipse Adoptium\jdk-11*") do (
  if exist "%%~D\bin\java.exe" (
    set "JavaSdkDirectory=%%~D"
    exit /b 0
  )
)
for /d %%D in ("%LOCALAPPDATA%\Programs\Eclipse Adoptium\jdk-11*") do (
  if exist "%%~D\bin\java.exe" (
    set "JavaSdkDirectory=%%~D"
    exit /b 0
  )
)
if defined JAVA_HOME (
  if exist "%JAVA_HOME%\bin\java.exe" (
    set "JavaSdkDirectory=%JAVA_HOME%"
    exit /b 0
  )
)
exit /b 0

:ResolveMsbuild
if defined MSBUILD (
  if exist "%MSBUILD%" exit /b 0
  echo ERROR: MSBUILD is set but not found:
  echo   %MSBUILD%
  exit /b 1
)

if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" (
  set "MSBUILD=%ProgramFiles%\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe"
  exit /b 0
)
if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe" (
  set "MSBUILD=%ProgramFiles%\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe"
  exit /b 0
)
if exist "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe" (
  set "MSBUILD=%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe"
  exit /b 0
)
if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe" (
  set "MSBUILD=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe"
  exit /b 0
)

where msbuild >nul 2>&1
if %errorlevel% equ 0 (
  for /f "delims=" %%i in ('where msbuild') do (
    set "MSBUILD=%%i"
    exit /b 0
  )
)

echo ERROR: MSBuild not found. Set MSBUILD to the full path of MSBuild.exe
echo ^(VS 2022 Developer Command Prompt / classic Xamarin toolchain^).
exit /b 1
