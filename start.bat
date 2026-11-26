@echo off
title DailyUploads Radar
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found! Please install Node.js 22.5+ first.
  pause
  exit /b 1
)

echo ==================================================
echo   DailyUploads Radar - Starting Server...
echo   URL: http://localhost:3456
echo ==================================================
echo.

start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3456"
node src\server.js
pause
