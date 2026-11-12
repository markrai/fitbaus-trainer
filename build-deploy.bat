@echo off
setlocal
echo Building and preparing deploy folder...
echo.
REM npm run build runs prebuild (syncs version.js -> src/version.ts + package.json + iOS) then tsc
call npm run build
if %errorlevel% neq 0 (
    echo Build failed.
    exit /b 1
)

node scripts/package-web-deploy.cjs
if %errorlevel% neq 0 (
    echo Packaging deploy folder failed.
    exit /b 1
)

echo.
echo Deploy folder ready: deploy\
echo Upload the contents of the "deploy" folder to your web server.
endlocal
