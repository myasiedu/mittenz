@echo off
echo ==========================================================
echo  Mittens PWA - Secure Local Network Server (via Pinggy)
echo ==========================================================
echo.

:: Check if Node/npx is installed
where npx >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js/npx is required for this secure setup.
    echo Please install Node.js from https://nodejs.org
    pause
    exit
)

echo Starting local web server on port 8080...
:: Start the local http-server in the background
start /b npx -y http-server "%~dp0pwa" -p 8080 --cors -c-1

echo.
echo Starting secure HTTPS tunnel via Pinggy...
echo ----------------------------------------------------------
echo.

:: Use Pinggy instead of localtunnel (no signup or keys required)
npx -y @pinggy/cli -p 8080

pause