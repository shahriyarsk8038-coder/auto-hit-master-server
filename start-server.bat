@echo off
title Auto Fill Master Admin Server
echo ========================================================
echo   Starting Auto Fill Master Admin Dashboard Server...
echo ========================================================
echo.

if exist "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe" (
    echo [INFO] Starting Auto Fill Master Server on http://localhost:3000/admin ...
    "C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe" server-standalone.js
    goto end
)

where node >nul 2>nul
if %errorlevel%==0 (
    echo [INFO] Starting Auto Fill Master Server...
    node server-standalone.js
    goto end
)

where python >nul 2>nul
if %errorlevel%==0 (
    echo [INFO] Starting Auto Fill Master Python Server...
    python server.py
    goto end
)

echo [ERROR] Could not start server. Please install Node.js or Python.
pause

:end

