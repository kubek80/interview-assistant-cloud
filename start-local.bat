@echo off
setlocal
cd /d "%~dp0"
title Interview Assistant (local)
echo.
echo  Interview Assistant - local trial
echo  ---------------------------------
echo.
docker info >nul 2>&1
if errorlevel 1 (
  echo  Docker is not running. Start Docker Desktop, wait until it says it is running,
  echo  then double-click this file again.
  echo.
  pause
  exit /b 1
)
echo  Building and starting. The first time takes a few minutes...
echo.
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo  Something went wrong while starting. The messages above say what.
  echo.
  pause
  exit /b 1
)
echo.
echo  Waiting for the app to be ready...
set /a tries=0
:wait
curl -s -f -o nul http://localhost:8080/healthz
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 90 goto slow
timeout /t 2 /nobreak >nul
goto wait
:slow
echo.
echo  The app has not answered after three minutes. Showing its last messages:
echo.
docker compose logs --tail 40 app
echo.
pause
exit /b 1
:ready
echo.
echo  Ready: http://localhost:8080
echo.
echo  Sign in:  click "Use it" next to admin@example.test, then "Sign in as this user".
echo  Others:   organiser@example.test, interviewer@example.test, reviewer@example.test
echo  Several people at once: use a private window or another browser profile.
echo.
echo  To stop: double-click stop-local.bat  (your data is kept)
echo.
start "" http://localhost:8080
pause
