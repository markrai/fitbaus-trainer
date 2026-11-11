@echo off
setlocal enabledelayedexpansion

REM Always run from the folder where this batch file lives (project root)
cd /d "%~dp0"

echo Starting FitBaus Trainer development server...
echo.

REM Build and update deploy folder (syncs version, compiles TS to dist, copies to deploy)
echo Running build and updating deploy folder...
call build-deploy.bat
if %errorlevel% neq 0 (
    echo ERROR: Build failed.
    exit /b 1
)
echo.

REM Optional: upload deploy folder to NAS (if deploy-upload.bat exists; copy from deploy-upload.bat.example)
if exist deploy-upload.bat (
    echo Uploading to NAS...
    call deploy-upload.bat
    echo/
)

REM Port (default 8000, or pass as first argument)
if not "%~1"=="" (
    set "PORT=%~1"
) else (
    set "PORT=8000"
)

REM Kill any existing process using this port so we can bind
call :kill_port %PORT%

echo Using port %PORT%
echo.

REM Prefer Node http-server (sends no-cache so browser gets fresh build)
where npx >nul 2>&1
if %errorlevel% == 0 (
    echo Using Node.js http-server (no cache^)...
    echo Server running at http://localhost:%PORT%
    echo Press Ctrl+C to stop the server
    echo.
    npx --yes http-server -p %PORT% -c-1
    goto :end
)

REM Fallback: Python 3
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo Using Python to start HTTP server...
    echo If you see an old version, do a hard refresh or clear cache.
    echo Server running at http://localhost:%PORT%
    echo Press Ctrl+C to stop the server
    echo.
    python -m http.server %PORT%
    goto :end
)

python3 --version >nul 2>&1
if %errorlevel% == 0 (
    echo Using Python 3 to start HTTP server...
    echo If you see an old version, do a hard refresh or clear cache.
    echo Server running at http://localhost:%PORT%
    echo Press Ctrl+C to stop the server
    echo.
    python3 -m http.server %PORT%
    goto :end
)

REM If nothing works, show error
echo ERROR: No suitable HTTP server found.
echo.
echo Please install one of the following:
echo   1. Python 3 (recommended): https://www.python.org/downloads/
echo   2. Node.js: https://nodejs.org/
echo.
echo Or use any other local HTTP server to serve the files.
pause

:end
endlocal
goto :eof

REM Kill any process listening on the given port (e.g. previous dev server).
:kill_port
setlocal
set "KPORT=%~1"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%KPORT% " ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1
    echo Killed existing process on port %KPORT% (PID %%a^)
)
endlocal
goto :eof
