@echo off
echo ==========================================================
echo  Mittens PWA - Local Network Server
echo ==========================================================
echo.

:: Try to find and display the machine's local IP
echo Your local IP address(es):
ipconfig | findstr /i "IPv4"
echo.
echo Open Chrome on ANY device on the same Wi-Fi and browse to:
echo   http://[YOUR-IP-ABOVE]:8080
echo.
echo Then tap the browser menu on the phone and choose
echo  "Add to Home Screen" to install as a standalone app.
echo.
echo Press Ctrl+C to stop the server when done.
echo ==========================================================
echo.

:: Check if npx is available, fall back to python http.server
where npx >nul 2>&1
if %ERRORLEVEL%==0 (
  echo Starting via npx http-server...
  npx -y http-server "%~dp0pwa" -p 8080 --cors -c-1
) else (
  where python >nul 2>&1
  if %ERRORLEVEL%==0 (
    echo Starting via Python http.server...
    python -m http.server 8080 --directory "%~dp0pwa"
  ) else (
    echo ERROR: Neither Node.js nor Python found.
    echo Install Node.js from https://nodejs.org or Python from https://python.org
    pause
  )
)
